import { homedir } from "node:os";
import { join } from "node:path";
import type { DeskInviteReplyRequest, DeskWriteResult } from "./contract";
import { buildReply, parseInvitation, replyMessage } from "./invitation";
import type { SmtpAccount } from "./smtp";
import { readLedger, writeLedger } from "./ledger";
import { Refusal } from "./writers";

export const inviteLedgerPath = (env: Record<string, string | undefined> = process.env): string =>
  join(env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "cortex-desk-adapters", "invite-replies.json");

export interface InviteReplyDeps {
  /** The text/calendar part of the INBOX message with this Message-ID, or undefined when it has none. */
  source: (account: string, messageId: string) => Promise<string | undefined>;
  smtp: (account: string) => Promise<SmtpAccount>;
  send: (account: SmtpAccount, rcpt: string, message: string) => Promise<void>;
  ledgerPath: string;
  now: () => number;
  newId: () => string;
}

const DONE: Record<DeskInviteReplyRequest["reply"], string> = { accept: "acceptance", decline: "decline" };

/**
 * Answers one invitation: reads the request's text/calendar part again from INBOX, checks it is still the invitation
 * the Desk showed (same UID) and that the account is an attendee, and sends the iTIP REPLY to the organizer. A request id
 * already sent sends nothing and reports the earlier reply.
 */
export async function answerInvitation(req: DeskInviteReplyRequest, deps: InviteReplyDeps): Promise<DeskWriteResult> {
  const known = (await readLedger(deps.ledgerPath, deps.now()))[req.requestId];
  if (known) return { id: known.id, message: `The ${DONE[req.reply]} was already sent.` };
  const ics = await deps.source(req.account, req.messageId);
  if (!ics) throw new Refusal(`The mail in the ${req.account} INBOX carries no calendar invitation.`);
  const account = await deps.smtp(req.account);
  const self = [account.from.toLowerCase(), account.user.toLowerCase()];
  const invitation = parseInvitation(ics, self);
  if (!invitation) throw new Refusal("The invitation could not be read, so it was not answered.");
  if (invitation.uid !== req.uid) throw new Refusal("The invitation in this mail is not the one the Desk showed, so it was not answered.");
  if (!invitation.attendee) throw new Refusal("You are not listed as an attendee of this invitation, so the Desk does not answer it.");
  const now = deps.now();
  const reply = buildReply(ics, { attendee: invitation.attendee.address, reply: req.reply, now });
  const domain = account.from.split("@")[1] ?? "localhost";
  const id = `${deps.newId()}@${domain}`;
  const message = replyMessage({
    from: account.from,
    ...(account.fromName ? { fromName: account.fromName } : {}),
    to: invitation.organizer.address,
    reply: req.reply,
    summary: invitation.summary,
    ics: reply,
    inReplyTo: req.messageId,
    messageId: id,
    boundary: `desk-${deps.newId()}`,
    date: new Date(now),
  });
  await deps.send(account, invitation.organizer.address, message);
  const ledger = await readLedger(deps.ledgerPath, deps.now());
  ledger[req.requestId] = { id, at: now };
  await writeLedger(deps.ledgerPath, ledger);
  return { id, message: `The ${DONE[req.reply]} went to ${invitation.organizer.name ?? invitation.organizer.address}.` };
}
