import type { DeskMailReportRequest } from "./cortex-contract";
import type { DeskWriteResult } from "./contract";
import { isRecord } from "./guards";
import { bareMessageId, folderByUse, pickFolder, type Folder } from "./move";
import { Refusal } from "./writers";

const MESSAGE_ID = /^[^\s<>]{1,512}$/;
const ACCOUNT = /^[\w.-]{1,64}$/;
const ADDRESS = /^[^\s<>,@"]+@[^\s<>,@"]+\.[^\s<>,@"]+$/;
const DRAFT_NAMES = ["Drafts", "Draft", "Entwürfe", "Brouillons"];
const MAX_SUBJECT = 200;
export const MAX_ORIGINAL = 25 * 1024 * 1024;
export const TOO_LARGE = "The message is larger than 25 MB, so it was not attached.";

/** The few IMAP calls the report command makes, so tests never reach a mail server. */
export interface PhishingReportBox {
  folders(): Promise<Folder[]>;
  source(folder: string, messageId: string): Promise<Uint8Array | undefined>;
  append(folder: string, content: Uint8Array, flags: string[]): Promise<void>;
}

/** Parses `{ action: "report", account, messageId, to }`, refusing anything else. */
export function readReportRequest(text: string): DeskMailReportRequest {
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Refusal("The request is not valid JSON.");
  }
  if (!isRecord(body) || body.action !== "report") throw new Refusal("This command only saves report drafts.");
  const { account, messageId, to } = body;
  if (typeof account !== "string" || !ACCOUNT.test(account)) throw new Refusal("The request names no valid account.");
  if (typeof messageId !== "string" || !MESSAGE_ID.test(bareMessageId(messageId))) throw new Refusal("The request has no valid Message-ID.");
  if (to === undefined) throw new Refusal("No report address is configured (mc.desk.mail.report.to), so no draft was saved.");
  if (typeof to !== "string" || !ADDRESS.test(to.trim())) throw new Refusal("The report address is not one valid email address.");
  return { action: "report", account, messageId: bareMessageId(messageId), to: to.trim() };
}

function originalSubject(raw: Uint8Array): string | undefined {
  const text = new TextDecoder("latin1").decode(raw.subarray(0, 64 * 1024));
  const head = text.split(/\r?\n\r?\n/)[0] ?? "";
  const subject = /^subject:[ \t]*(.*(?:\r?\n[ \t].*)*)/im.exec(head)?.[1]?.replace(/\r?\n[ \t]+/g, " ").trim();
  return subject && /^[\x20-\x7e]+$/.test(subject) ? subject.slice(0, MAX_SUBJECT) : undefined;
}

const has = (haystack: Uint8Array, needle: string): boolean => Buffer.from(haystack).includes(needle);

export interface ReportDraftInput {
  from?: string;
  to: string;
  messageId: string;
  original: Uint8Array;
  boundary: string;
  draftId: string;
  date: Date;
}

/**
 * A draft that forwards the original unchanged as a message/rfc822 attachment, the form abuse desks ask for. The text
 * part names the Message-ID; the subject keeps the original's when it is plain ASCII.
 */
export function reportDraft({ from, to, messageId, original, boundary, draftId, date }: ReportDraftInput): Uint8Array {
  if (has(original, boundary)) throw new Error("the boundary occurs in the original message");
  const subject = originalSubject(original);
  const eightBit = original.some((b) => b > 0x7f);
  const head = [
    ...(from ? [`From: ${from}`] : []),
    `To: ${to}`,
    `Subject: Phishing report${subject ? `: ${subject}` : ""}`,
    `Date: ${date.toUTCString()}`,
    `Message-ID: <${draftId}>`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: 7bit",
    "",
    "I received the attached message and believe it is phishing. It is attached unchanged as message/rfc822.",
    `Message-ID: <${messageId}>`,
    "",
    `--${boundary}`,
    "Content-Type: message/rfc822",
    'Content-Disposition: attachment; filename="reported-message.eml"',
    `Content-Transfer-Encoding: ${eightBit ? "8bit" : "7bit"}`,
    "",
    "",
  ].join("\r\n");
  const endsWithBreak = original.length > 0 && original[original.length - 1] === 0x0a;
  const tail = `${endsWithBreak ? "" : "\r\n"}--${boundary}--\r\n`;
  return new Uint8Array(Buffer.concat([Buffer.from(head, "utf8"), Buffer.from(original), Buffer.from(tail, "utf8")]));
}


export interface ReportOptions {
  inbox?: string;
  from?: string;
  now?: () => Date;
  newId?: () => string;
}

/**
 * Saves a report draft to `req.to` in the account's Drafts with the original attached. The original is read from INBOX,
 * else from Junk (Spam may come first), never changed. It never sends and never moves or deletes anything.
 */
export async function saveReportDraft(req: DeskMailReportRequest, box: PhishingReportBox, opts: ReportOptions = {}): Promise<DeskWriteResult> {
  const folders = await box.folders();
  const drafts = folderByUse(folders, "\\Drafts", DRAFT_NAMES);
  if (!drafts) throw new Refusal(`The ${req.account} account has no Drafts mailbox, so no report was saved.`);
  const junk = pickFolder(folders, "junk");
  const places = [opts.inbox ?? "INBOX", ...(junk ? [junk] : [])];
  let original: Uint8Array | undefined;
  for (const place of places) {
    original = await box.source(place, req.messageId);
    if (original) break;
  }
  if (!original) throw new Refusal(`The message is no longer in the ${req.account} ${places.join(" or ")}, so it was not reported.`);
  if (original.length > MAX_ORIGINAL) throw new Refusal(TOO_LARGE);
  const id = opts.newId?.() ?? crypto.randomUUID();
  const draftId = `desk-report-${id}@desk.invalid`;
  const from = opts.from && ADDRESS.test(opts.from) ? opts.from : undefined;
  const content = reportDraft({ ...(from ? { from } : {}), to: req.to, messageId: req.messageId, original, boundary: `desk-report-${id}`, draftId, date: (opts.now ?? (() => new Date()))() });
  await box.append(drafts, content, ["\\Draft", "\\Seen"]);
  return { id: draftId, message: `A report draft to ${req.to} is in your ${req.account} ${drafts}. Send it from there.` };
}
