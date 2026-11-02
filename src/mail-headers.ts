import type { DeskAuthVerdict, DeskMailHeaders } from "./contract";
import { HOST } from "./host";

const TEXT_FIELDS = {
  listId: { name: "list-id", max: 300 },
  listUnsubscribe: { name: "list-unsubscribe", max: 2000 },
  listUnsubscribePost: { name: "list-unsubscribe-post", max: 200 },
  replyTo: { name: "reply-to", max: 300 },
  inReplyTo: { name: "in-reply-to", max: 1000 },
} as const;

const MAX_REFERENCES = 20;
const MESSAGE_ID_IN = /<([^<>\s]{1,512})>/g;

/** The Message-IDs in a References or In-Reply-To value, without angle brackets, the last `max` (the closest ancestors). */
export function messageIds(value: string | undefined, max = MAX_REFERENCES): string[] {
  if (!value) return [];
  const ids = [...new Set([...value.matchAll(MESSAGE_ID_IN)].flatMap((m) => (m[1] ? [m[1]] : [])))];
  return ids.slice(-max);
}

type TextField = keyof typeof TEXT_FIELDS;

export const HEADER_FIELDS: string[] = [...Object.values(TEXT_FIELDS).map((f) => f.name), "authentication-results", "references"];

const VERDICTS: readonly DeskAuthVerdict[] = ["pass", "fail", "softfail", "neutral", "none", "temperror", "permerror", "policy"];

const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f]/g;

function unfold(raw: string): Map<string, string[]> {
  const fields = new Map<string, string[]>();
  const joined: string[] = [];
  for (const line of raw.replace(/\r\n/g, "\n").split("\n")) {
    if (/^[ \t]/.test(line) && joined.length > 0) joined[joined.length - 1] += ` ${line.trim()}`;
    else if (line.trim()) joined.push(line);
  }
  for (const line of joined) {
    const colon = line.indexOf(":");
    if (colon < 1) continue;
    const name = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).replace(CONTROL, "").replace(/\s+/g, " ").trim();
    if (!value) continue;
    fields.set(name, [...(fields.get(name) ?? []), value]);
  }
  return fields;
}

const withoutComments = (value: string): string => {
  let out = value;
  for (let previous = ""; previous !== out; ) {
    previous = out;
    out = out.replace(/\([^()]*\)/g, " ");
  }
  return out;
};

const authservId = (results: string): string => withoutComments(results).split(";")[0]?.trim().split(/\s+/)[0]?.toLowerCase() ?? "";

const resinfos = (results: string): string[] => withoutComments(results).split(";").slice(1);

function verdict(results: string, method: "spf" | "dkim" | "dmarc"): DeskAuthVerdict | undefined {
  const found = resinfos(results)
    .map((resinfo) => new RegExp(`^\\s*${method}\\s*=\\s*([a-z]+)`, "i").exec(resinfo)?.[1]?.toLowerCase())
    .find((v) => v !== undefined);
  return VERDICTS.find((v) => v === found);
}

const MAX_SIGNERS = 10;

const hostOf = (raw: string | undefined): string | undefined => {
  const host = raw?.toLowerCase().replace(/\.$/, "");
  return host && HOST.test(host) ? host : undefined;
};

const signer = (resinfo: string): string | undefined =>
  hostOf(/\bheader\.d\s*=\s*"?([a-z0-9.-]+)/i.exec(resinfo)?.[1] ?? /\bheader\.i\s*=\s*"?[^@\s;"]*@([a-z0-9.-]+)/i.exec(resinfo)?.[1]);

function dkimDomains(results: string): string[] {
  const passing = resinfos(results)
    .filter((resinfo) => /^\s*dkim\s*=\s*pass\b/i.test(resinfo))
    .flatMap((resinfo) => signer(resinfo) ?? []);
  return [...new Set(passing)].slice(0, MAX_SIGNERS);
}

function spfDomain(results: string): string | undefined {
  const spf = resinfos(results).find((resinfo) => /^\s*spf\s*=/i.test(resinfo));
  return spf ? hostOf(/\bsmtp\.mailfrom\s*=\s*"?(?:[^@\s;"]*@)?([a-z0-9.-]+)/i.exec(spf)?.[1]) : undefined;
}

function authResults(values: string[] | undefined, trusted: readonly string[]): DeskMailHeaders["authResults"] {
  const ids = trusted.map((t) => t.toLowerCase());
  const header = ids.length > 0 ? values?.find((v) => ids.includes(authservId(v))) : values?.[0];
  if (!header) return undefined;
  const spf = verdict(header, "spf");
  const dkim = verdict(header, "dkim");
  const dmarc = verdict(header, "dmarc");
  if (!spf && !dkim && !dmarc) return undefined;
  const mailFrom = spfDomain(header);
  return { ...(spf ? { spf } : {}), ...(dkim ? { dkim } : {}), ...(dmarc ? { dmarc } : {}), dkimDomains: dkimDomains(header), ...(mailFrom ? { spfDomain: mailFrom } : {}) };
}

/**
 * The headers later Desk steps need, from a raw header block. Values are unfolded, stripped of control characters and
 * dropped when too long. Authentication-Results gives SPF, DKIM and DMARC verdicts from one header: the topmost, or,
 * with `trustedAuthserv`, the topmost whose authserv-id is listed (none listed: no verdicts). Comments such as an ARC
 * chain's `(i=1 spf=pass …)` are ignored. `dkimDomains` lists the signing domains (header.d, else header.i) of every
 * passing DKIM signature in that header, and `spfDomain` the domain SPF checked (smtp.mailfrom). A header that cannot be read is left out, so a malformed message never drops the mail.
 */
export function parseMailHeaders(raw: string, trustedAuthserv: readonly string[] = []): DeskMailHeaders | undefined {
  const fields = unfold(raw);
  const headers: DeskMailHeaders = {};
  for (const key of Object.keys(TEXT_FIELDS) as TextField[]) {
    const { name, max } = TEXT_FIELDS[key];
    const value = fields.get(name)?.[0];
    if (value && value.length <= max) headers[key] = value;
  }
  const references = messageIds(fields.get("references")?.[0]);
  if (references.length > 0) headers.references = references;
  const auth = authResults(fields.get("authentication-results"), trustedAuthserv);
  if (auth) headers.authResults = auth;
  return Object.keys(headers).length > 0 ? headers : undefined;
}

/** The headers of one fetched message, as imapflow returns them for `headers: HEADER_FIELDS`. */
export const headersOf = (m: { headers?: Buffer }, trustedAuthserv: readonly string[] = []): DeskMailHeaders | undefined =>
  m.headers ? parseMailHeaders(m.headers.toString("utf8"), trustedAuthserv) : undefined;
