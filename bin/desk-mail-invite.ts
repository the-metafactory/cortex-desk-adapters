#!/usr/bin/env bun
/**
 * desk-mail-invite: the Desk's invitation-reply command (`mc.desk.mail.invitations.command`). Reads
 * `{ "action": "invite-reply", "account", "messageId", "uid", "reply": "accept" | "decline", "requestId" }` on stdin,
 * reads the mail's text/calendar part again from INBOX (read-only), and sends the iTIP REPLY (RFC 5546, iMIP RFC 6047)
 * to the organizer through the account's SMTP server. It never moves, deletes or changes mail or calendars. A request id
 * it already sent sends nothing. Uses the selected mail account config (default ~/.config/email/config.json); needs curl.
 * Usage: desk-mail-invite [--config <path>] [--mailbox INBOX]
 */
import { parseArgs } from "node:util";
import { invitationSource } from "../src/imap";
import { answerInvitation, inviteLedgerPath } from "../src/invite-reply";
import { readInviteReplyRequest } from "../src/invitation";
import { mailAccountRecord } from "../src/mail-config";
import { spawnRunner } from "../src/run";
import { sendMail, smtpAccount } from "../src/smtp";
import { runWriter } from "../src/writers";

const { values } = parseArgs({
  options: {
    config: { type: "string" },
    mailbox: { type: "string" },
  },
});

await runWriter(async (text) => {
  const req = readInviteReplyRequest(text);
  // An explicit config must be readable even when the reply is already in the ledger.
  if (values.config !== undefined) await mailAccountRecord(req.account, values.config);
  return answerInvitation(req, {
    source: (account, messageId) => invitationSource(account, messageId, values.mailbox ?? "INBOX", values.config),
    smtp: (account) => smtpAccount(account, spawnRunner, values.config),
    send: (account, rcpt, message) => sendMail(account, rcpt, message, spawnRunner),
    ledgerPath: inviteLedgerPath(),
    now: Date.now,
    newId: () => crypto.randomUUID(),
  });
});
