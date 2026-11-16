#!/usr/bin/env bun
/**
 * desk-mail-dmarc: the Desk's DMARC report reader (`mc.desk.mail.dmarc.command`). Reads one request on stdin,
 *   { "action": "dmarc", "account", "messageId" },
 * fetches the report attachment (zip, gzip or XML, RFC 7489 aggregate format) of the one INBOX message with that
 * Message-ID, read-only, and prints per-domain counts. A malformed, oversized or foreign attachment exits 3 with one
 * sentence on stderr; any other failure (no connection, message gone) exits 1. Uses the selected mail account config (default ~/.config/email/config.json).
 * Usage: desk-mail-dmarc [--config <path>] [--mailbox INBOX]
 */
import { parseArgs } from "node:util";
import { dmarcReport, readDmarcRequest, ReportRefusal } from "../src/dmarc";
import { withReportMailbox } from "../src/imap";
import { Refusal } from "../src/writers";

const { values } = parseArgs({ options: { config: { type: "string" }, mailbox: { type: "string" } } });

try {
  const req = readDmarcRequest(await new Response(Bun.stdin.stream()).text());
  const report = await withReportMailbox(req.account, (box) => dmarcReport(req, box), values.mailbox, values.config);
  process.stdout.write(`${JSON.stringify(report)}\n`);
  process.exit(0);
} catch (error) {
  const sentence = error instanceof Refusal ? error.message : `The DMARC reader failed: ${(error as Error).message}`;
  process.stderr.write(`${sentence.replace(/\s*\n\s*/g, " ")}\n`);
  process.exit(error instanceof ReportRefusal ? 3 : 1);
}
