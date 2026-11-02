#!/usr/bin/env bun
/**
 * desk-mail: recent mail from the `email` CLI as Desk items.
 * Usage: desk-mail --account work --account personal [--days 3] [--limit 40] [--bodies 15] [--authserv mx.example.org]...
 * Bodies are fetched read-only (no --mark-read) for the newest unread messages only. Headers (List-Id, List-Unsubscribe,
 * Authentication-Results, Reply-To, In-Reply-To) are read over IMAP with BODY.PEEK; without them the mail is listed as before.
 * For the same unread messages, the links of the HTML body whose text names a host are read with BODY.PEEK too.
 * With --sent, the account's sent mail of the last --sent-days days (default 14, newest --sent-limit, default 40) is
 * listed too, as `sent` items with the replies found in INBOX and the archive, read-only.
 * For the same unread messages, a text/calendar part that holds a meeting request becomes the item's `invitation`.
 */
import { parseArgs } from "node:util";
import { toDeskMail, firstParagraph, type EmailListEntry } from "../src/mail";
import type { DeskMailHeaders, DeskMailInvitation, DeskMailLink, DeskSourceMail, DeskSourceOutput, DeskSourceSentMail } from "../src/contract";
import { errorText, readHeaders, readInvitations, readLinks, readSent } from "../src/imap";
import { accountAddresses } from "../src/smtp";

const { values } = parseArgs({
  options: {
    account: { type: "string", multiple: true, default: ["work"] },
    days: { type: "string", default: "3" },
    limit: { type: "string", default: "40" },
    bodies: { type: "string", default: "15" },
    authserv: { type: "string", multiple: true, default: [] },
    sent: { type: "boolean", default: false },
    "sent-days": { type: "string", default: "14" },
    "sent-limit": { type: "string", default: "40" },
  },
});

const whole = (raw: string | undefined, name: string, max: number): number => {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > max) {
    process.stderr.write(`desk-mail: --${name} must be a whole number from 1 to ${max}.\n`);
    process.exit(1);
  }
  return n;
};
const sentDays = values.sent ? whole(values["sent-days"], "sent-days", 90) : 0;
const sentLimit = values.sent ? whole(values["sent-limit"], "sent-limit", 200) : 0;

async function run(args: string[]): Promise<string> {
  const proc = Bun.spawn(["email", ...args], { stdout: "pipe", stderr: "pipe" });
  const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  if (code !== 0) throw new Error(`email ${args[0]} exited ${code}`);
  return out;
}

const items: (DeskSourceMail | DeskSourceSentMail)[] = [];
for (const account of values.account ?? []) {
  const listed = JSON.parse(await run(["list", "-a", account, "-s", values.days ?? "3", "-l", values.limit ?? "40", "-o", "json"])) as EmailListEntry[];
  const unread = listed.filter((m) => !m.flags.includes("\\Seen")).slice(0, Number(values.bodies));
  const paragraphs = new Map<number, string | undefined>();
  for (const m of unread) {
    try {
      paragraphs.set(m.uid, firstParagraph(await run(["get", "-a", account, "-u", String(m.uid)])));
    } catch {
      paragraphs.set(m.uid, m.snippet);
    }
  }
  const warn = (line: string): void => void process.stderr.write(`desk-mail: ${account}: ${line}\n`);
  const orEmpty = <V>(what: string) => (err: unknown): Map<number, V> => {
    warn(`${what} were not read: ${errorText(err)}`);
    return new Map();
  };
  const self = await accountAddresses(account).catch(() => []);
  const [headers, links, invitations] = await Promise.all([
    readHeaders(account, listed.map((m) => m.uid), values.authserv).catch(orEmpty<DeskMailHeaders>("headers")),
    readLinks(account, unread.map((m) => m.uid), warn).catch(orEmpty<DeskMailLink[]>("links")),
    readInvitations(account, unread.map((m) => m.uid), self, warn).catch(orEmpty<DeskMailInvitation>("invitations")),
  ]);
  for (const m of listed) {
    const item = toDeskMail(m, account, paragraphs.get(m.uid) ?? m.snippet);
    const h = headers.get(m.uid);
    const l = links.get(m.uid);
    const invitation = invitations.get(m.uid);
    items.push({ ...item, ...(h ? { headers: h } : {}), ...(l ? { links: l } : {}), ...(invitation ? { invitation } : {}) });
  }
  if (values.sent) {
    try {
      items.push(...(await readSent(account, { days: sentDays, limit: sentLimit, warn })));
    } catch (err) {
      warn(`sent mail was not read: ${errorText(err)}`);
    }
  }
}

const output: DeskSourceOutput = { capabilities: ["attention"], items };
process.stdout.write(JSON.stringify(output));
