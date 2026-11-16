import type { DeskSourceMail } from "./contract";
import { htmlText } from "./html-text";

/** One message as `email list -o json` prints it. */
export interface EmailListEntry {
  uid: number;
  messageId: string;
  from: string;
  subject: string;
  date: string;
  snippet?: string;
  flags: string[];
}

/** "Finance & Controlling <fc@example.ch>" → { name, address }. */
export function parseFrom(raw: string): { name?: string; address: string } {
  const match = raw.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/);
  if (!match) return { address: raw.trim().toLowerCase() };
  const name = match[1]?.trim();
  return { ...(name ? { name } : {}), address: (match[2] ?? "").trim().toLowerCase() };
}

/** Apple Mail opens a message from its Message-ID: message://%3Cid%3E. */
export function appleMailUrl(messageId: string): string {
  return `message://${encodeURIComponent(`<${messageId.replace(/^<|>$/g, "")}>`)}`;
}

const GREETING = /^(hi|hello|hallo|hoi|salut|bonjour|dear|liebe|lieber|sehr geehrte|grüezi|guten tag)\b.{0,60}[,!:]?$/i;

/** What the `email` CLI prints as the body of a message that has no plain-text part. */
export const NO_BODY = "(no body)";

/** The body of `email get` output: the text after the second ━━━ line. */
function bodyOf(getOutput: string): string {
  const parts = getOutput.split(/^━+$/m);
  return (parts.length >= 3 ? parts.slice(2).join("") : getOutput).trim();
}

/** True when `email get` printed the CLI's placeholder instead of a plain-text body. */
export function hasNoTextBody(getOutput: string): boolean {
  return bodyOf(getOutput) === NO_BODY;
}

const oneLine = (text: string): string => text.replace(/\s+/g, " ").trim().toLowerCase();

function paragraphOf(body: string, subject?: string): string | undefined {
  if (body.trim() === NO_BODY) return undefined;
  const paragraphs = body.split(/\n\s*\n/).map((p) => p.replace(/\s+/g, " ").trim()).filter(Boolean);
  const heading = subject === undefined ? undefined : oneLine(subject);
  const first = paragraphs.find((p) => !(p.length <= 60 && GREETING.test(p)) && oneLine(p) !== heading);
  if (!first) return undefined;
  return first.length > 400 ? `${first.slice(0, 397).trimEnd()}…` : first;
}

/**
 * The first paragraph a person would read: the body of `email get`, split on blank lines, skipping a short greeting
 * line and a heading that only repeats the subject, collapsed to one line and capped at 400 characters.
 * The CLI's `(no body)` placeholder is no paragraph.
 */
export function firstParagraph(getOutput: string, subject?: string): string | undefined {
  return paragraphOf(bodyOf(getOutput), subject);
}

/** The same paragraph from `email get --html` output, read from the HTML body's visible text. */
export function firstParagraphOfHtml(getHtmlOutput: string, subject?: string): string | undefined {
  return paragraphOf(htmlText(bodyOf(getHtmlOutput)), subject);
}

/**
 * The first paragraph of one message, read without marking it read (never `--mark-read`): the plain-text body, and
 * only when the CLI has none, the HTML body. `run` takes the `email` CLI's arguments and returns what it prints.
 */
export async function readFirstParagraph(run: (args: string[]) => Promise<string>, account: string, uid: number, subject?: string): Promise<string | undefined> {
  const text = await run(["get", "-a", account, "-u", String(uid)]);
  if (!hasNoTextBody(text)) return firstParagraph(text, subject);
  return firstParagraphOfHtml(await run(["get", "--html", "-a", account, "-u", String(uid)]), subject);
}

/**
 * The messages whose body is read: the newest `count` listed INBOX messages, read or unread, and the newest `count`
 * unread ones beyond them. A read message can still wait in the inbox, and its card needs the paragraph too.
 */
export function bodyTargets(listed: EmailListEntry[], count: number): EmailListEntry[] {
  return [...new Set([...listed.slice(0, count), ...unreadTargets(listed, count)])];
}

/** The newest `count` unread listed messages: the ones whose links are read. */
export function unreadTargets(listed: EmailListEntry[], count: number): EmailListEntry[] {
  return listed.filter((m) => !m.flags.includes("\\Seen")).slice(0, count);
}

export function toDeskMail(entry: EmailListEntry, account: string, paragraph: string | undefined): DeskSourceMail {
  return {
    kind: "mail",
    id: entry.messageId.replace(/^<|>$/g, ""),
    from: parseFrom(entry.from),
    subject: entry.subject || "(no subject)",
    receivedAt: new Date(entry.date).toISOString(),
    unread: !entry.flags.includes("\\Seen"),
    ...(paragraph && paragraph.trim() !== NO_BODY ? { firstParagraph: paragraph } : {}),
    url: appleMailUrl(entry.messageId),
    account,
  };
}

/** The same paragraph from an HTML body read directly (over IMAP), by the same visible-text rules as `firstParagraphOfHtml`. */
export function firstParagraphOfHtmlBody(html: string, subject?: string): string | undefined {
  return paragraphOf(htmlText(html), subject);
}
