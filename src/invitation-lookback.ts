import type { DeskMailInvitation, DeskSourceMail } from "./contract";
import { appleMailUrl } from "./mail";
import { bareMessageId } from "./move";
import { address, type SentEnvelope } from "./sent";

/**
 * Bounds of the invitation look-back: INBOX mail older than the listing window is read only for its invitation, from
 * the last `days` days, scanning at most the newest `scan` messages and adding at most `limit` mails.
 */
export const LOOKBACK = { days: 14, maxDays: 60, scan: 200, maxScan: 1000, limit: 10, maxLimit: 50 } as const;

/** The highest SEQUENCE the principal answered, by invitation UID, read from the iTIP REPLYs in the Sent folders. */
export type Replies = ReadonlyMap<string, number>;

export function addReply(replies: Map<string, number>, reply: { uid: string; sequence: number }): void {
  const known = replies.get(reply.uid);
  if (known === undefined || reply.sequence > known) replies.set(reply.uid, reply.sequence);
}

/** A reply in Sent answers the invitation when it is for the same UID and at least as new a SEQUENCE. */
export const answeredInSent = (inv: DeskMailInvitation, replies: Replies): boolean => (replies.get(inv.uid) ?? -1) >= inv.sequence;

/** The event is over at its end (its start without an end). A recurring invitation is never over: later meetings may follow. */
export function invitationOver(inv: DeskMailInvitation, now: number): boolean {
  if (inv.recurring) return false;
  const end = Date.parse(inv.end ?? inv.start);
  return Number.isFinite(end) && end <= now;
}

/** The invitation still waits for the principal: not answered in Sent and not over. Being read does not answer it. */
export const invitationOpen = (inv: DeskMailInvitation, replies: Replies, now: number): boolean => !answeredInSent(inv, replies) && !invitationOver(inv, now);

export interface LookbackCandidate {
  uid: number;
  envelope: SentEnvelope;
  flags: ReadonlySet<string> | undefined;
  invitation: DeskMailInvitation;
}

/** One INBOX mail read only for its invitation, as a Desk mail item; null without a Message-ID, a sender or a date. */
export function lookbackMail(c: LookbackCandidate, account: string): DeskSourceMail | null {
  const id = c.envelope.messageId ? bareMessageId(c.envelope.messageId) : "";
  const from = address(c.envelope.from?.[0]);
  if (!id || !from || !c.envelope.date || Number.isNaN(c.envelope.date.getTime())) return null;
  const subject = (c.envelope.subject ?? "").replace(/\s+/g, " ").trim().slice(0, 500) || "(no subject)";
  return {
    kind: "mail",
    id,
    from,
    subject,
    receivedAt: c.envelope.date.toISOString(),
    unread: !(c.flags?.has("\\Seen") ?? false),
    url: appleMailUrl(id),
    account,
    invitation: c.invitation,
  };
}

/**
 * The look-back mails to add: open invitations only, not already listed (by Message-ID), newest first, at most `limit`.
 * No other mail is added, so read mail without an open invitation never comes back.
 */
export function lookbackItems(candidates: readonly LookbackCandidate[], input: { account: string; listed: ReadonlySet<string>; replies: Replies; now: number; limit: number }): DeskSourceMail[] {
  const seen = new Set(input.listed);
  const out: DeskSourceMail[] = [];
  for (const c of [...candidates].sort((a, b) => b.uid - a.uid)) {
    if (out.length >= input.limit) break;
    if (!invitationOpen(c.invitation, input.replies, input.now)) continue;
    const mail = lookbackMail(c, input.account);
    if (!mail || seen.has(mail.id)) continue;
    seen.add(mail.id);
    out.push(mail);
  }
  return out;
}
