import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { isRecord } from "./guards";
import type { Runner } from "./run";
import { Refusal } from "./writers";

export type MailConfigReader = (path: string) => Promise<string>;
export interface MailConfig {
  accounts: Record<string, unknown>;
  defaultAccount?: string;
}

export const mailConfigPath = (): string => join(homedir(), ".config", "email", "config.json");
const readText: MailConfigReader = (path) => readFile(path, "utf8");

/** Reads the existing mail account format; the default path stays compatible with the personal email CLI. */
export async function readMailConfig(path = mailConfigPath(), read: MailConfigReader = readText): Promise<MailConfig> {
  let config: unknown;
  try {
    config = JSON.parse(await read(path));
  } catch {
    throw new Refusal("The mail config could not be read.");
  }
  const accounts = isRecord(config) && isRecord(config.accounts) ? config.accounts : {};
  const defaultAccount = isRecord(config) && typeof config.defaultAccount === "string" && config.defaultAccount ? config.defaultAccount : undefined;
  return { accounts, ...(defaultAccount ? { defaultAccount } : {}) };
}

export async function mailAccountRecord(name: string, path = mailConfigPath(), read: MailConfigReader = readText): Promise<Record<string, unknown>> {
  const { accounts } = await readMailConfig(path, read);
  const key = Object.keys(accounts).find((k) => k.toLowerCase() === name.toLowerCase());
  const account = key === undefined ? undefined : accounts[key];
  if (!isRecord(account)) throw new Refusal(`There is no ${name} account in the mail config.`);
  return account;
}

/** Resolves a password the way the `email` CLI does: keychain:<service>, env:<VAR>, or the value itself. */
export async function resolvePassword(value: string, run: Runner, env: Record<string, string | undefined> = process.env): Promise<string> {
  if (value.startsWith("keychain:")) {
    const result = await run(["security", "find-generic-password", "-s", value.slice("keychain:".length), "-w"]);
    const pass = result.stdout.trim();
    if (result.code !== 0 || !pass) throw new Refusal("The mail password could not be read from the keychain.");
    return pass;
  }
  if (value.startsWith("env:")) {
    const pass = env[value.slice("env:".length)];
    if (!pass) throw new Refusal("The mail password's environment variable is not set.");
    return pass;
  }
  return value;
}
