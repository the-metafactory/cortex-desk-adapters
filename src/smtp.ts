import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isRecord } from "./guards";
import { mailAccountRecord, mailConfigPath, readMailConfig, resolvePassword } from "./mail-config";
import { lastLine, type Runner } from "./run";
import { Refusal } from "./writers";

export interface SmtpAccount {
  name: string;
  host: string;
  port: number;
  secure: boolean;
  user: string;
  pass: string;
  from: string;
  fromName?: string;
}

export const ADDRESS = /^[^\s<>,@"]+@[^\s<>,@"]+$/;
const HOST = /^[A-Za-z0-9.-]{1,253}$/;
const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);

/** The mail config's default account, which a command uses when a request names none. */
export async function defaultAccountName(path = mailConfigPath()): Promise<string> {
  const { defaultAccount } = await readMailConfig(path);
  if (!defaultAccount) throw new Refusal("The mail config names no default account.");
  return defaultAccount;
}

/** The account's own addresses (its From address and its SMTP and IMAP user names that are addresses), lowercased. */
export async function accountAddresses(name: string, path = mailConfigPath()): Promise<string[]> {
  const account = await mailAccountRecord(name, path);
  const from = isRecord(account.from) ? str(account.from.email) : undefined;
  const smtpUser = isRecord(account.smtp) && isRecord(account.smtp.auth) ? str(account.smtp.auth.user) : undefined;
  const imapUser = isRecord(account.imap) && isRecord(account.imap.auth) ? str(account.imap.auth.user) : undefined;
  return [...new Set([from, smtpUser, imapUser].flatMap((a) => (a && ADDRESS.test(a.trim()) ? [a.trim().toLowerCase()] : [])))];
}

/**
 * The From address of every account in the mail config, lowercased: the addresses the principal configured as their own.
 * A login name is left out, even one shaped like an address, because a relay or shared-mailbox login may belong to someone else.
 */
export async function ownAddresses(path = mailConfigPath()): Promise<string[]> {
  const { accounts } = await readMailConfig(path);
  const froms = Object.values(accounts).flatMap((account) => {
    const from = isRecord(account) && isRecord(account.from) ? str(account.from.email)?.trim() : undefined;
    return from && ADDRESS.test(from) ? [from.toLowerCase()] : [];
  });
  return [...new Set(froms)];
}

/** Reads one account's SMTP settings and From address from the selected mail config, resolving the password. */
export async function smtpAccount(name: string, run: Runner, path = mailConfigPath()): Promise<SmtpAccount> {
  const account = await mailAccountRecord(name, path);
  const smtp = isRecord(account.smtp) ? account.smtp : undefined;
  const auth = smtp && isRecord(smtp.auth) ? smtp.auth : {};
  const host = str(smtp?.host);
  const user = str(auth.user);
  const pass = str(auth.pass);
  const from = isRecord(account.from) ? str(account.from.email)?.trim() : undefined;
  const fromName = isRecord(account.from) ? str(account.from.name)?.trim() : undefined;
  if (!smtp || !host || !HOST.test(host) || typeof smtp.port !== "number" || !user || !pass) throw new Refusal(`The ${name} account has no SMTP settings.`);
  if (!from || !ADDRESS.test(from)) throw new Refusal(`The ${name} account has no From address.`);
  return { name, host, port: smtp.port, secure: smtp.secure === true, user, pass: await resolvePassword(pass, run), from, ...(fromName ? { fromName } : {}) };
}

const quoted = (value: string): string => `"${value.replace(/[\\"]/g, "\\$&")}"`;

export type SmtpMechanism = "LOGIN" | "PLAIN" | "any";

/** Tried in turn: curl's own choice ("any") picks NTLM or GSSAPI when a server (Exchange) offers them, so it comes last. */
const SMTP_MECHANISMS: readonly SmtpMechanism[] = ["LOGIN", "PLAIN", "any"];
const AUTH_FAILED = new Set([67, 94]);

/** curl's config for one SMTP submission: implicit TLS for a secure account, else STARTTLS is required. */
export function curlConfig(account: SmtpAccount, rcpt: string, mechanism: SmtpMechanism = "LOGIN"): string {
  if (/[\r\n]/.test(account.user + account.pass + rcpt + account.from)) throw new Refusal("The SMTP settings hold a line break.");
  return [
    `url = ${quoted(`${account.secure ? "smtps" : "smtp"}://${account.host}:${account.port}`)}`,
    ...(account.secure ? [] : ["ssl-reqd"]),
    `user = ${quoted(`${account.user}:${account.pass}`)}`,
    ...(mechanism === "any" ? [] : [`login-options = ${quoted(`AUTH=${mechanism}`)}`]),
    `mail-from = ${quoted(account.from)}`,
    `mail-rcpt = ${quoted(rcpt)}`,
  ].join("\n");
}

/**
 * Submits one message to the account's SMTP server through curl. The password goes to curl on stdin as its config, never
 * in argv; the message goes through a private temporary file that is removed afterwards.
 */
export async function sendMail(account: SmtpAccount, rcpt: string, message: string, run: Runner): Promise<void> {
  if (!ADDRESS.test(rcpt)) throw new Refusal("The recipient is not one plain address.");
  const dir = await mkdtemp(join(tmpdir(), "desk-invite-"));
  try {
    const file = join(dir, "message.eml");
    await writeFile(file, message, { mode: 0o600 });
    let result = { code: 1, stdout: "", stderr: "" };
    for (const mechanism of SMTP_MECHANISMS) {
      result = await run(["curl", "-sS", "--max-time", "25", "-K", "-", "--upload-file", file], curlConfig(account, rcpt, mechanism));
      if (!AUTH_FAILED.has(result.code)) break;
    }
    if (result.code !== 0) throw new Refusal(`The ${account.name} mail server did not take the reply: ${lastLine(result.stderr) || `curl exited with code ${result.code}`}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
