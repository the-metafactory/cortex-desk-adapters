#!/usr/bin/env bun
/**
 * desk-mail-draft: the Desk's reply-draft command. Reads `{ "action": "draft", "account", "messageId", "to", "subject", "body" }`
 * on stdin and saves the reply in the account's Drafts with `email draft create`. It never sends mail.
 * With --config <path> it appends the draft over IMAP using that mail account file, with no `email` CLI.
 * Usage: desk-mail-draft [--email /path/to/email] [--config <path>]
 */
import { parseArgs } from "node:util";
import { readDraftRequest, saveDraft, saveDraftImap } from "../src/draft";
import { withDraftBox } from "../src/imap";
import { spawnRunner } from "../src/run";
import { runWriter } from "../src/writers";

const { values } = parseArgs({
  options: {
    email: { type: "string" },
    config: { type: "string" },
  },
});

await runWriter(async (text) => {
  const req = readDraftRequest(text);
  const { config } = values;
  if (config === undefined) return saveDraft(req, spawnRunner, values.email);
  return withDraftBox(req.account, (box, from) => saveDraftImap(req, box, { from }), config);
});
