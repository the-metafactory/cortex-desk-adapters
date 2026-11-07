#!/usr/bin/env bun
/**
 * desk-mail-send: sends one mail to one of the principal's own addresses through the account's SMTP server. Reads
 * `{ "account"?, "to"?, "subject", "body", "html"? }` from `--request-file` or stdin, and prints `{ "id", "message" }`. With no
 * `to`, the mail goes to the account's From address. A recipient outside the email config's own addresses, any cc or bcc,
 * any line break in a subject or address, and an html value holding more than plain formatting and http links are refused
 * with no send. With `html`, the mail is multipart/alternative; without it, one text part. Uses the `email` CLI's account config; needs curl.
 * Usage: desk-mail-send [--request-file <path>]
 */
import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { readMailSendRequest, sendOwnMail } from "../src/mail-send";
import { spawnRunner } from "../src/run";
import { defaultAccountName, ownAddresses, sendMail, smtpAccount } from "../src/smtp";
import { runWriter } from "../src/writers";

const { values } = parseArgs({ options: { "request-file": { type: "string" } } });
const requestFile = values["request-file"];

await runWriter(async (stdin) =>
  sendOwnMail(readMailSendRequest(requestFile === undefined ? stdin : await readFile(requestFile, "utf8")), {
    defaultAccount: () => defaultAccountName(),
    ownAddresses: () => ownAddresses(),
    smtp: (account) => smtpAccount(account, spawnRunner),
    send: (account, rcpt, message) => sendMail(account, rcpt, message, spawnRunner),
    now: Date.now,
    newId: () => crypto.randomUUID(),
  }),
);
