import type { DeskWriteResult } from "./contract";
import { isRecord } from "./guards";
import { base64Lines, headerWord, senderHeader } from "./invitation";
import { ADDRESS, type SmtpAccount } from "./smtp";
import { Refusal } from "./writers";

export interface MailSendRequest {
  account?: string;
  to?: string;
  subject: string;
  body: string;
}

export interface MailSendDeps {
  defaultAccount: () => Promise<string>;
  /** The principal's own addresses, lowercased, from their email config. The only recipients this command mails. */
  ownAddresses: () => Promise<string[]>;
  smtp: (account: string) => Promise<SmtpAccount>;
  send: (account: SmtpAccount, rcpt: string, message: string) => Promise<void>;
  now: () => number;
  newId: () => string;
}

const ACCOUNT = /^[\w.-]{1,64}$/;
const HEADER_UNSAFE = /[\u0000-\u001f\u007f\u0085\u2028\u2029]/;
const SUBJECT_MAX = 300;
const BODY_MAX = 200_000;
const REQUEST_FIELDS = new Set(["account", "to", "subject", "body"]);

const absent = (value: unknown): boolean => value === undefined || value === null || value === "" || (Array.isArray(value) && value.length === 0);

/** Parses `{ account?, to?, subject, body }`, refusing a cc or bcc, a field it does not know, and anything that is not one plain address or one header-safe line. */
export function readMailSendRequest(text: string): MailSendRequest {
  let fields: unknown;
  try {
    fields = JSON.parse(text);
  } catch {
    throw new Refusal("The request is not valid JSON.");
  }
  if (!isRecord(fields)) throw new Refusal("The request has no fields.");
  for (const [key, value] of Object.entries(fields)) {
    if (/^(cc|bcc)$/i.test(key)) {
      if (!absent(value)) throw new Refusal("A routine may not mail a cc or bcc, so nothing was sent.");
    } else if (!REQUEST_FIELDS.has(key)) {
      throw new Refusal("The request holds a field this command does not take, so nothing was sent.");
    }
  }
  const { account, to, subject, body } = fields;
  if (account !== undefined && (typeof account !== "string" || !ACCOUNT.test(account))) throw new Refusal("The account is not one plain name.");
  if (to !== undefined && (typeof to !== "string" || !ADDRESS.test(to))) throw new Refusal("The recipient is not one plain address, so nothing was sent.");
  if (typeof subject !== "string" || !subject.trim() || subject.length > SUBJECT_MAX || HEADER_UNSAFE.test(subject)) {
    throw new Refusal(`The subject must be one line of at most ${SUBJECT_MAX} characters, so nothing was sent.`);
  }
  if (typeof body !== "string" || !body.trim() || body.length > BODY_MAX) throw new Refusal(`The body must hold text, at most ${BODY_MAX} characters, so nothing was sent.`);
  return { ...(account === undefined ? {} : { account }), ...(to === undefined ? {} : { to }), subject: subject.trim(), body };
}

/** One text mail. Only the subject and the checked addresses reach a header; the base64 body cannot add one. */
export function ownMailMessage(input: { account: SmtpAccount; rcpt: string; subject: string; body: string; messageId: string; date: Date }): string {
  return [
    `From: ${senderHeader(input.account.from, input.account.fromName)}`,
    `To: ${input.rcpt}`,
    `Subject: ${headerWord(input.subject)}`,
    `Date: ${input.date.toUTCString().replace("GMT", "+0000")}`,
    `Message-ID: <${input.messageId}>`,
    "Auto-Submitted: auto-generated",
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: base64",
    "",
    base64Lines(input.body),
    "",
  ].join("\r\n");
}

/**
 * Sends one mail to one of the principal's own addresses, by default the sending account's From address. The recipient
 * limit is enforced here, against the email config, so no routine, model or action input can widen it. The address sent to
 * is the config's own entry, never the request's spelling of it.
 */
export async function sendOwnMail(req: MailSendRequest, deps: MailSendDeps): Promise<DeskWriteResult> {
  const account = await deps.smtp(req.account ?? (await deps.defaultAccount()));
  const wanted = (req.to ?? account.from).toLowerCase();
  const rcpt = (await deps.ownAddresses()).find((address) => address === wanted);
  if (rcpt === undefined) throw new Refusal("That recipient is not one of the principal's own configured addresses, so nothing was sent.");
  const id = `${deps.newId()}@${account.from.split("@")[1] ?? "localhost"}`;
  await deps.send(account, rcpt, ownMailMessage({ account, rcpt, subject: req.subject, body: req.body, messageId: id, date: new Date(deps.now()) }));
  return { id, message: `The mail went to ${rcpt}.` };
}
