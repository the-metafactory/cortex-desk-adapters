#!/usr/bin/env bun
import { parseArgs } from "node:util";
import { ImapFlow } from "imapflow";
import { Refusal } from "../src/writers";
import { firstParagraph, resolveImapSource, textPart, toDeskMail, UsageError, type StructureNode } from "../src/imap-mail";
import { HEADER_FIELDS, headersOf } from "../src/mail-headers";
import type { DeskSourceMail, DeskSourceOutput } from "../src/contract";

const { values } = parseArgs({
  options: {
    host: { type: "string" },
    port: { type: "string" },
    user: { type: "string" },
    "password-env": { type: "string" },
    starttls: { type: "boolean", default: false },
    mailbox: { type: "string", default: "INBOX" },
    account: { type: "string" },
    config: { type: "string" },
    limit: { type: "string", default: "30" },
    authserv: { type: "string", multiple: true, default: [] },
  },
});

const fail = (line: string): never => {
  process.stderr.write(`${line}\n`);
  process.exit(1);
};

const limit = Number(values.limit);
if (!Number.isInteger(limit) || limit < 1 || limit > 200) fail("--limit must be a whole number from 1 to 200.");

const source = await resolveImapSource(values).catch((err: unknown) => {
  if (err instanceof UsageError) {
    process.stderr.write(`${err.message}\n`);
    process.exit(2);
  }
  return fail(err instanceof Refusal ? err.message : `desk-imap: ${err instanceof Error ? err.message : String(err)}`);
});

const client = new ImapFlow({
  host: source.host,
  port: source.port,
  secure: source.secure,
  ...(source.starttls ? { doSTARTTLS: true } : {}),
  auth: { user: source.user, pass: source.pass },
  logger: false,
});

async function readText(uid: number, structure: StructureNode | undefined): Promise<string | undefined> {
  const part = textPart(structure);
  if (!part) return undefined;
  const { content } = await client.download(String(uid), part, { uid: true, maxBytes: 16_384 });
  const chunks: Buffer[] = [];
  for await (const chunk of content) chunks.push(Buffer.from(chunk));
  return firstParagraph(Buffer.concat(chunks).toString("utf8"));
}

try {
  await client.connect();
  const lock = await client.getMailboxLock(values.mailbox ?? "INBOX", { readOnly: true });
  const items: DeskSourceMail[] = [];
  try {
    const uids = (await client.search({ seen: false }, { uid: true })) || [];
    const newest = uids.sort((a, b) => b - a).slice(0, limit);
    if (newest.length > 0) {
      const messages = await client.fetchAll(newest, { envelope: true, bodyStructure: true, internalDate: true, headers: HEADER_FIELDS }, { uid: true });
      for (const m of messages) {
        const paragraph = await readText(m.uid, m.bodyStructure).catch(() => undefined);
        const received = m.internalDate instanceof Date ? m.internalDate : new Date();
        const item = m.envelope ? toDeskMail(m.envelope, source.account, paragraph, received) : null;
        const headers = headersOf(m, values.authserv);
        if (item) items.push(headers ? { ...item, headers } : item);
      }
    }
  } finally {
    lock.release();
  }
  await client.logout();
  const output: DeskSourceOutput = { capabilities: ["attention"], items };
  process.stdout.write(JSON.stringify(output));
} catch (err) {
  fail(`desk-imap: ${err instanceof Error ? err.message : String(err)}`);
}
