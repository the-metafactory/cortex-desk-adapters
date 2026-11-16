import type { DeskSourceMail } from "./cortex-contract";
import { imapAccount } from "./imap-account";
import type { MailConfigReader } from "./mail-config";
import { spawnRunner, type Runner } from "./run";
import { Refusal } from "./writers";

export class UsageError extends Error {}

export interface ImapSource {
  account: string;
  host: string;
  port: number;
  secure: boolean;
  starttls: boolean;
  user: string;
  pass: string;
}

export interface ImapArgs {
  host?: string;
  port?: string;
  user?: string;
  "password-env"?: string;
  starttls?: boolean;
  account?: string;
  config?: string;
}

export interface ImapDeps {
  env?: Record<string, string | undefined>;
  readConfig?: MailConfigReader;
  run?: Runner;
}

/** Resolves where desk-imap connects: an account in the mail config file, or the flag route. */
export async function resolveImapSource(args: ImapArgs, deps: ImapDeps = {}): Promise<ImapSource> {
  if (args.config !== undefined) {
    if (args.host !== undefined || args.user !== undefined) throw new UsageError("Use --config or --host and --user, not both.");
    if (!args.account) throw new UsageError("desk-imap --config needs --account.");
    const acct = await imapAccount(args.account, deps.run ?? spawnRunner, args.config, deps.readConfig);
    return { account: acct.name, host: acct.host, port: acct.port, secure: acct.secure, starttls: false, user: acct.user, pass: acct.pass };
  }
  const env = deps.env ?? process.env;
  if (!args.host) throw new UsageError("Usage: desk-imap --host <imap host> --user <login> [--password-env DESK_IMAP_PASSWORD] [--account <label>]");
  if (!args.user) throw new UsageError("desk-imap needs --user.");
  const passwordVar = args["password-env"] ?? "DESK_IMAP_PASSWORD";
  const pass = env[passwordVar];
  if (!pass) throw new Refusal(`Set the IMAP password in the environment variable ${passwordVar}.`);
  const port = Number(args.port ?? "993");
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Refusal("--port must be a whole number from 1 to 65535.");
  const starttls = args.starttls === true;
  return { account: args.account ?? "mail", host: args.host, port, secure: !starttls, starttls, user: args.user, pass };
}

export interface StructureNode {
  part?: string;
  type: string;
  disposition?: string;
  childNodes?: StructureNode[];
}

export interface ListedEnvelope {
  messageId?: string;
  subject?: string;
  date?: Date;
  from?: { name?: string; address?: string }[];
}

export function textPart(node: StructureNode | undefined): string | null {
  if (!node) return null;
  if (node.childNodes?.length) {
    for (const child of node.childNodes) {
      const found = textPart(child);
      if (found) return found;
    }
    return null;
  }
  if (node.type.toLowerCase() !== "text/plain" || node.disposition?.toLowerCase() === "attachment") return null;
  return node.part ?? "1";
}

const GREETING = /^(hi|hello|hey|dear|hallo|liebe[rs]?|guten tag|bonjour|salut)\b[^.!?]{0,40}[,!]?$/i;

export function firstParagraph(text: string, max = 400): string | undefined {
  const paragraphs = text
    .replace(/\r\n/g, "\n")
    .split(/\n\s*\n/)
    .map((p) => p.split("\n").filter((l) => !l.startsWith(">")).join(" ").replace(/\s+/g, " ").trim())
    .filter((p) => p.length > 0 && !GREETING.test(p));
  const first = paragraphs[0];
  if (!first) return undefined;
  return first.length > max ? `${first.slice(0, max - 1)}…` : first;
}

const bare = (id: string): string => id.trim().replace(/^<|>$/g, "");

export function toDeskMail(envelope: ListedEnvelope, account: string, paragraph: string | undefined, fallbackDate: Date): DeskSourceMail | null {
  const sender = envelope.from?.[0];
  const address = sender?.address?.trim().toLowerCase();
  const id = envelope.messageId ? bare(envelope.messageId) : "";
  if (!address || !id) return null;
  const name = sender?.name?.trim();
  return {
    kind: "mail",
    id,
    from: name ? { name, address } : { address },
    subject: envelope.subject?.trim() || "(no subject)",
    receivedAt: (envelope.date ?? fallbackDate).toISOString(),
    unread: true,
    ...(paragraph ? { firstParagraph: paragraph } : {}),
    account,
  };
}
