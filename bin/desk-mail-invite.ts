#!/usr/bin/env bun
/**
 * desk-mail-invite: the Desk's invitation-reply command (`mc.desk.mail.invitations.command`). Reads
 * `{ "action": "invite-reply", "account", "messageId", "uid", "reply": "accept" | "decline", "requestId" }` on stdin,
 * reads the mail's text/calendar part again from INBOX (read-only), and sends the iTIP REPLY (RFC 5546, iMIP RFC 6047)
 * to the organizer through the account's SMTP server. It never moves, deletes or changes mail or calendars. A request id
 * it already sent sends nothing. Uses the `email` CLI's account config; needs curl.
 * Usage: desk-mail-invite [--mailbox INBOX]
 */
import { parseArgs } from "node:util";
import { invitationSource } from "../src/imap";
import { answerInvitation, inviteLedgerPath } from "../src/invite-reply";
import { readInviteReplyRequest } from "../src/invitation";
import { spawnRunner } from "../src/run";
import { sendMail, smtpAccount } from "../src/smtp";
import { runWriter } from "../src/writers";

const { values } = parseArgs({
  options: {
    mailbox: { type: "string" },
  },
});

await runWriter(async (text) =>
  answerInvitation(readInviteReplyRequest(text), {
    source: (account, messageId) => invitationSource(account, messageId, values.mailbox ?? "INBOX"),
    smtp: (account) => smtpAccount(account, spawnRunner),
    send: (account, rcpt, message) => sendMail(account, rcpt, message, spawnRunner),
    ledgerPath: inviteLedgerPath(),
    now: Date.now,
    newId: () => crypto.randomUUID(),
  }),
);
