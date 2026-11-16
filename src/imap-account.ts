import { isRecord } from "./guards";
import { mailAccountRecord, mailConfigPath, resolvePassword } from "./mail-config";
import type { Runner } from "./run";
import { Refusal } from "./writers";

export { resolvePassword } from "./mail-config";

export interface ImapAccount {
  name: string;
  host: string;
  port: number;
  secure: boolean;
  user: string;
  pass: string;
}

const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);

/** Reads one account's IMAP settings from the selected mail config, resolving its password. */
export async function imapAccount(name: string, run: Runner, path = mailConfigPath()): Promise<ImapAccount> {
  const account = await mailAccountRecord(name, path);
  const imap = isRecord(account.imap) ? account.imap : undefined;
  const smtpAuth = isRecord(account.smtp) && isRecord(account.smtp.auth) ? account.smtp.auth : {};
  const imapAuth = imap && isRecord(imap.auth) ? imap.auth : {};
  const host = str(imap?.host);
  const user = str(imapAuth.user) ?? str(smtpAuth.user);
  const pass = str(imapAuth.pass) ?? str(smtpAuth.pass);
  if (!imap || imap.enabled !== true || !host || typeof imap.port !== "number" || !user || !pass) {
    throw new Refusal(`The ${name} account has no IMAP settings.`);
  }
  return { name, host, port: imap.port, secure: imap.tls === true, user, pass: await resolvePassword(pass, run) };
}
