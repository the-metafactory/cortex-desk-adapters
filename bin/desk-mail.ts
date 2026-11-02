#!/usr/bin/env bun
/**
 * desk-mail: recent mail from the `email` CLI as Desk items.
 * Usage: desk-mail --account work --account personal [--days 3] [--limit 40] [--bodies 15] [--authserv mx.example.org]...
 * Bodies are fetched read-only (no --mark-read) for the newest unread messages only. Headers (List-Id, List-Unsubscribe,
 * Authentication-Results, Reply-To, In-Reply-To) are read over IMAP with BODY.PEEK; without them the mail is listed as before.
 * For the same unread messages, the links of the HTML body whose text names a host are read with BODY.PEEK too.
 */
import { parseArgs } from "node:util";
import { toDeskMail, firstParagraph, type EmailListEntry } from "../src/mail";
import type { DeskMailHeaders, DeskMailLink, DeskSourceMail, DeskSourceOutput } from "../src/contract";
import { readHeaders, readLinks } from "../src/imap";

const { values } = parseArgs({
  options: {
    account: { type: "string", multiple: true, default: ["work"] },
    days: { type: "string", default: "3" },
    limit: { type: "string", default: "40" },
    bodies: { type: "string", default: "15" },
    authserv: { type: "string", multiple: true, default: [] },
  },
});

async function run(args: string[]): Promise<string> {
  const proc = Bun.spawn(["email", ...args], { stdout: "pipe", stderr: "pipe" });
  const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  if (code !== 0) throw new Error(`email ${args[0]} exited ${code}`);
  return out;
}

const items: DeskSourceMail[] = [];
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
    warn(`${what} were not read: ${err instanceof Error ? err.message : String(err)}`);
    return new Map();
  };
  const [headers, links] = await Promise.all([
    readHeaders(account, listed.map((m) => m.uid), values.authserv).catch(orEmpty<DeskMailHeaders>("headers")),
    readLinks(account, unread.map((m) => m.uid), warn).catch(orEmpty<DeskMailLink[]>("links")),
  ]);
  for (const m of listed) {
    const item = toDeskMail(m, account, paragraphs.get(m.uid) ?? m.snippet);
    const h = headers.get(m.uid);
    const l = links.get(m.uid);
    items.push({ ...item, ...(h ? { headers: h } : {}), ...(l ? { links: l } : {}) });
  }
}

const output: DeskSourceOutput = { capabilities: ["attention"], items };
process.stdout.write(JSON.stringify(output));
