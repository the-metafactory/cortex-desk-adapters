#!/usr/bin/env bun
import { parseArgs } from "node:util";
import { ImapFlow } from "imapflow";
import { Refusal } from "../src/writers";
import { resolveImapSource, UsageError } from "../src/imap-mail";
import { errorText, imapReadBox, readItems, readSentItems } from "../src/imap";
import { LOOKBACK } from "../src/invitation-lookback";
import { accountAddresses } from "../src/smtp";
import type { DeskSourceOutput } from "../src/contract";

const { values } = parseArgs({
  options: {
    host: { type: "string" },
    port: { type: "string" },
    user: { type: "string" },
    "password-env": { type: "string" },
    starttls: { type: "boolean", default: false },
    mailbox: { type: "string", default: "INBOX" },
    account: { type: "string" },
    config: { type: "string" },
    limit: { type: "string", default: "30" },
    authserv: { type: "string", multiple: true, default: [] },
    "invite-days": { type: "string", default: String(LOOKBACK.days) },
    "invite-scan": { type: "string", default: String(LOOKBACK.scan) },
    "invite-limit": { type: "string", default: String(LOOKBACK.limit) },
    sent: { type: "boolean", default: false },
    "sent-days": { type: "string", default: "14" },
    "sent-limit": { type: "string", default: "40" },
  },
});

const fail = (line: string): never => {
  process.stderr.write(`${line}\n`);
  process.exit(1);
};

const whole = (raw: string | undefined, name: string, max: number): number => {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > max) fail(`--${name} must be a whole number from 1 to ${max}.`);
  return n;
};

const limit = whole(values.limit, "limit", 200);
const inviteDays = whole(values["invite-days"], "invite-days", LOOKBACK.maxDays);
const inviteScan = whole(values["invite-scan"], "invite-scan", LOOKBACK.maxScan);
const inviteLimit = whole(values["invite-limit"], "invite-limit", LOOKBACK.maxLimit);
const sentDays = values.sent ? whole(values["sent-days"], "sent-days", 90) : 0;
const sentLimit = values.sent ? whole(values["sent-limit"], "sent-limit", 200) : 0;

const source = await resolveImapSource(values).catch((err: unknown) => {
  if (err instanceof UsageError) {
    process.stderr.write(`${err.message}\n`);
    process.exit(2);
  }
  return fail(err instanceof Refusal ? err.message : `desk-imap: ${err instanceof Error ? err.message : String(err)}`);
});

const warn = (line: string): void => void process.stderr.write(`desk-imap: ${source.account}: ${line}\n`);

const self = values.config !== undefined ? await accountAddresses(source.account, values.config).catch(() => []) : source.user.includes("@") ? [source.user.toLowerCase()] : [];
if (self.length === 0) warn("the account has no address of its own, so invitations are listed without an attendee");

const client = new ImapFlow({
  host: source.host,
  port: source.port,
  secure: source.secure,
  ...(source.starttls ? { doSTARTTLS: true } : {}),
  auth: { user: source.user, pass: source.pass },
  logger: false,
});
client.on("error", () => undefined);

try {
  await client.connect();
  const items = await readItems(imapReadBox(client), {
    account: source.account,
    mailbox: values.mailbox ?? "INBOX",
    limit,
    self,
    authserv: values.authserv,
    invite: { days: inviteDays, scan: inviteScan, limit: inviteLimit },
    warn,
  });
  const sent = values.sent
    ? await readSentItems(imapReadBox(client), { account: source.account, days: sentDays, limit: sentLimit, warn }).catch((err: unknown) => {
        warn(`sent mail was not read: ${errorText(err)}`);
        return [];
      })
    : [];
  await client.logout();
  const output: DeskSourceOutput = { capabilities: ["attention"], items: [...items, ...sent] };
  process.stdout.write(JSON.stringify(output));
} catch (err) {
  fail(`desk-imap: ${errorText(err)}`);
}
