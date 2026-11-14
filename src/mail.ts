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

function paragraphOf(body: string): string | undefined {
  if (body.trim() === NO_BODY) return undefined;
  const paragraphs = body.split(/\n\s*\n/).map((p) => p.replace(/\s+/g, " ").trim()).filter(Boolean);
  const first = paragraphs.find((p) => !(p.length <= 60 && GREETING.test(p)));
  if (!first) return undefined;
  return first.length > 400 ? `${first.slice(0, 397).trimEnd()}…` : first;
}

/**
 * The first paragraph a person would read: the body of `email get`, split on blank lines,
 * skipping a short greeting line, collapsed to one line and capped at 400 characters.
 * The CLI's `(no body)` placeholder is no paragraph.
 */
export function firstParagraph(getOutput: string): string | undefined {
  return paragraphOf(bodyOf(getOutput));
}

/** The same paragraph from `email get --html` output, read from the HTML body's visible text. */
export function firstParagraphOfHtml(getHtmlOutput: string): string | undefined {
  const body = bodyOf(getHtmlOutput);
  return body === NO_BODY ? undefined : paragraphOf(htmlText(body));
}

/**
 * The first paragraph of one message, read without marking it read (never `--mark-read`): the plain-text body, and
 * only when the CLI has none, the HTML body. `run` takes the `email` CLI's arguments and returns what it prints.
 */
export async function readFirstParagraph(run: (args: string[]) => Promise<string>, account: string, uid: number): Promise<string | undefined> {
  const text = await run(["get", "-a", account, "-u", String(uid)]);
  if (!hasNoTextBody(text)) return firstParagraph(text);
  return firstParagraphOfHtml(await run(["get", "--html", "-a", account, "-u", String(uid)]));
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
