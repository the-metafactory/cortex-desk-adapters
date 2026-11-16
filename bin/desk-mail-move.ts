#!/usr/bin/env bun
/**
 * desk-mail-move: the Desk's move command (`mc.desk.mail.actions.move`). Reads one request on stdin and prints one result:
 *   { "action": "move", "account", "messageId", "target": "archive" | "junk" | "trash" } moves the one INBOX message
 *     with that Message-ID to the account's folder for the target;
 *   { "action": "restore", "account", "messageId", "from": "archive" | "junk" | "trash" } moves it back to INBOX (Undo);
 *   { "action": "locate", "account", "messageId" } reports, read-only, whether it is in INBOX, Archive, Junk, Trash or gone.
 * IMAP MOVE only; it never deletes or expunges. Uses the selected mail account config (default ~/.config/email/config.json).
 * Usage: desk-mail-move [--config <path>] [--mailbox INBOX]
 */
import { parseArgs } from "node:util";
import { withMailbox } from "../src/imap";
import { locateMessage, moveMessage, readMoveRequest, restoreMessage } from "../src/move";
import { runWriter } from "../src/writers";
import type { DeskWriteResult } from "../src/contract";

const { values } = parseArgs({
  options: {
    config: { type: "string" },
    mailbox: { type: "string" },
  },
});

await runWriter(async (text) => {
  const req = readMoveRequest(text);
  return withMailbox<DeskWriteResult>(req.account, (box) => {
    if (req.action === "locate") return locateMessage(req, box, values.mailbox);
    return req.action === "move" ? moveMessage(req, box, values.mailbox) : restoreMessage(req, box, values.mailbox);
  }, values.config);
});
