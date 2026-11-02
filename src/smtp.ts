import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { isRecord } from "./guards";
import { resolvePassword } from "./imap-account";
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

const ADDRESS = /^[^\s<>,@"]+@[^\s<>,@"]+$/;
const HOST = /^[A-Za-z0-9.-]{1,253}$/;
const emailConfigPath = (): string => join(homedir(), ".config", "email", "config.json");
const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);

async function accountRecord(name: string, path: string): Promise<Record<string, unknown>> {
  let config: unknown;
  try {
    config = JSON.parse(await readFile(path, "utf8"));
  } catch {
    throw new Refusal("The email config could not be read.");
  }
  const accounts = isRecord(config) && isRecord(config.accounts) ? config.accounts : {};
  const key = Object.keys(accounts).find((k) => k.toLowerCase() === name.toLowerCase());
  const account = key === undefined ? undefined : accounts[key];
  if (!isRecord(account)) throw new Refusal(`There is no ${name} account in the email config.`);
  return account;
}

/** The account's own addresses (its From address and its SMTP and IMAP user names that are addresses), lowercased. */
export async function accountAddresses(name: string, path = emailConfigPath()): Promise<string[]> {
  const account = await accountRecord(name, path);
  const from = isRecord(account.from) ? str(account.from.email) : undefined;
  const smtpUser = isRecord(account.smtp) && isRecord(account.smtp.auth) ? str(account.smtp.auth.user) : undefined;
  const imapUser = isRecord(account.imap) && isRecord(account.imap.auth) ? str(account.imap.auth.user) : undefined;
  return [...new Set([from, smtpUser, imapUser].flatMap((a) => (a && ADDRESS.test(a.trim()) ? [a.trim().toLowerCase()] : [])))];
}

/** Reads one account's SMTP settings and From address from the `email` CLI's config, resolving the password. */
export async function smtpAccount(name: string, run: Runner, path = emailConfigPath()): Promise<SmtpAccount> {
  const account = await accountRecord(name, path);
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

/** curl's config for one SMTP submission: implicit TLS for a secure account, else STARTTLS is required. */
export function curlConfig(account: SmtpAccount, rcpt: string): string {
  if (/[\r\n]/.test(account.user + account.pass + rcpt + account.from)) throw new Refusal("The SMTP settings hold a line break.");
  return [
    `url = ${quoted(`${account.secure ? "smtps" : "smtp"}://${account.host}:${account.port}`)}`,
    ...(account.secure ? [] : ["ssl-reqd"]),
    `user = ${quoted(`${account.user}:${account.pass}`)}`,
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
    const result = await run(["curl", "-sS", "--max-time", "25", "-K", "-", "--upload-file", file], curlConfig(account, rcpt));
    if (result.code !== 0) throw new Refusal(`The ${account.name} mail server did not take the reply: ${lastLine(result.stderr) || `curl exited with code ${result.code}`}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
