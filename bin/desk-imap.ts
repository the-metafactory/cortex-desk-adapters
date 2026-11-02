#!/usr/bin/env bun
import { parseArgs } from "node:util";
import { ImapFlow } from "imapflow";
import { firstParagraph, textPart, toDeskMail, type StructureNode } from "../src/imap-mail";
import { HEADER_FIELDS, headersOf } from "../src/mail-headers";
import type { DeskSourceMail, DeskSourceOutput } from "../src/contract";

const { values } = parseArgs({
  options: {
    host: { type: "string" },
    port: { type: "string", default: "993" },
    user: { type: "string" },
    "password-env": { type: "string", default: "DESK_IMAP_PASSWORD" },
    starttls: { type: "boolean", default: false },
    mailbox: { type: "string", default: "INBOX" },
    account: { type: "string", default: "mail" },
    limit: { type: "string", default: "30" },
    authserv: { type: "string", multiple: true, default: [] },
  },
});

const fail = (line: string): never => {
  process.stderr.write(`${line}\n`);
  process.exit(1);
};

const host = values.host ?? fail("Usage: desk-imap --host <imap host> --user <login> [--password-env DESK_IMAP_PASSWORD] [--account <label>]");
const user = values.user ?? fail("desk-imap needs --user.");
const passwordVar = values["password-env"] ?? "DESK_IMAP_PASSWORD";
const pass = process.env[passwordVar] || fail(`Set the IMAP password in the environment variable ${passwordVar}.`);
const limit = Number(values.limit);
if (!Number.isInteger(limit) || limit < 1 || limit > 200) fail("--limit must be a whole number from 1 to 200.");

const port = Number(values.port);
if (!Number.isInteger(port) || port < 1 || port > 65535) fail("--port must be a whole number from 1 to 65535.");

const client = new ImapFlow({
  host,
  port,
  secure: !values.starttls,
  ...(values.starttls ? { doSTARTTLS: true } : {}),
  auth: { user, pass },
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
        const item = m.envelope ? toDeskMail(m.envelope, values.account ?? "mail", paragraph, received) : null;
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
