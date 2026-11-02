import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { DeskDeclinedCopyRequest, DeskWriteResult } from "./contract";
import { isRecord } from "./guards";
import { lastLine, type Runner } from "./run";
import { Refusal } from "./writers";

export type Ews = (body: string) => Promise<string>;

export interface EwsAccount {
  url: string;
  user: string;
  pass: string;
}

interface CalendarItem {
  id: string;
  uid: string;
  organizer: boolean;
  type: string;
}

const ACCOUNT = /^[\w.-]{1,64}$/;
const UID = /^[^\r\n]{1,1000}$/;
const DAY_MS = 86_400_000;
const ORGANIZED = "You organize this event, so the Desk does not remove it.";
const NS = 'xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/" xmlns:t="http://schemas.microsoft.com/exchange/services/2006/types" xmlns:m="http://schemas.microsoft.com/exchange/services/2006/messages"';

export function readDeclinedCopyRequest(text: string): DeskDeclinedCopyRequest {
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Refusal("The request is not valid JSON.");
  }
  if (!isRecord(body) || body.action !== "remove-declined") throw new Refusal("This command only removes declined invitations.");
  const { account, uid, start, end, recurring } = body;
  if (typeof account !== "string" || !ACCOUNT.test(account)) throw new Refusal("The request names no valid account.");
  if (typeof uid !== "string" || !UID.test(uid)) throw new Refusal("The request has no valid invitation UID.");
  if (typeof start !== "string" || Number.isNaN(Date.parse(start))) throw new Refusal("The request has no valid start time.");
  if (end !== undefined && (typeof end !== "string" || Number.isNaN(Date.parse(end)))) throw new Refusal("The request has an invalid end time.");
  return { action: "remove-declined", account, uid, start, ...(typeof end === "string" ? { end } : {}), ...(recurring === true ? { recurring: true } : {}) };
}

const escapeXml = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const unescapeXml = (s: string): string =>
  s.replace(/&(lt|gt|quot|apos|amp|#\d+|#x[0-9a-f]+);/gi, (_, e: string) => {
    const named: Record<string, string> = { lt: "<", gt: ">", quot: '"', apos: "'", amp: "&" };
    const lower = e.toLowerCase();
    if (lower in named) return named[lower] ?? "";
    return String.fromCodePoint(lower.startsWith("#x") ? Number.parseInt(lower.slice(2), 16) : Number.parseInt(lower.slice(1), 10));
  });

const envelope = (body: string): string =>
  `<?xml version="1.0" encoding="utf-8"?><soap:Envelope ${NS}><soap:Header><t:RequestServerVersion Version="Exchange2013"/></soap:Header><soap:Body>${body}</soap:Body></soap:Envelope>`;

const elements = (xml: string, name: string): string[] => [...xml.matchAll(new RegExp(`<(?:\\w+:)?${name}\\b[^>]*?(?:/>|>([\\s\\S]*?)</(?:\\w+:)?${name}>)`, "g"))].map((m) => m[0]);

const text = (xml: string, name: string): string | undefined => {
  const m = new RegExp(`<(?:\\w+:)?${name}\\b[^>]*>([\\s\\S]*?)</(?:\\w+:)?${name}>`).exec(xml);
  return m?.[1] === undefined ? undefined : unescapeXml(m[1]);
};

const attr = (xml: string, element: string, name: string): string | undefined => {
  const tag = new RegExp(`<(?:\\w+:)?${element}\\b[^>]*>`).exec(xml)?.[0];
  const m = tag ? new RegExp(`\\s${name}="([^"]*)"`).exec(tag) : null;
  return m?.[1] === undefined ? undefined : unescapeXml(m[1]);
};

function failure(xml: string): string | undefined {
  const fault = text(xml, "faultstring");
  if (fault) return fault;
  for (const msg of elements(xml, "\\w+ResponseMessage")) {
    const cls = attr(msg, "\\w+ResponseMessage", "ResponseClass");
    const code = text(msg, "ResponseCode");
    if (cls !== "Success" && code !== "ErrorItemNotFound") return text(msg, "MessageText") ?? code ?? "Exchange refused the request.";
  }
  return undefined;
}

function calendarItems(xml: string): CalendarItem[] {
  return elements(xml, "CalendarItem").flatMap((item) => {
    const id = attr(item, "ItemId", "Id");
    const uid = text(item, "UID");
    if (!id || uid === undefined) return [];
    return [{ id, uid, organizer: text(item, "IsOrganizer") === "true", type: text(item, "CalendarItemType") ?? "Single" }];
  });
}

const SHAPE = '<m:ItemShape><t:BaseShape>IdOnly</t:BaseShape><t:AdditionalProperties><t:FieldURI FieldURI="calendar:UID"/><t:FieldURI FieldURI="calendar:IsOrganizer"/><t:FieldURI FieldURI="calendar:CalendarItemType"/></t:AdditionalProperties></m:ItemShape>';

async function call(ews: Ews, body: string): Promise<string> {
  const xml = await ews(envelope(body));
  const why = failure(xml);
  if (why) throw new Error(why);
  return xml;
}

async function findCopies(req: DeskDeclinedCopyRequest, ews: Ews): Promise<CalendarItem[]> {
  const from = new Date(Date.parse(req.start) - DAY_MS).toISOString();
  const to = new Date(Date.parse(req.end ?? req.start) + DAY_MS).toISOString();
  const xml = await call(ews, `<m:FindItem Traversal="Shallow">${SHAPE}<m:CalendarView StartDate="${from}" EndDate="${to}"/><m:ParentFolderIds><t:DistinguishedFolderId Id="calendar"/></m:ParentFolderIds></m:FindItem>`);
  return calendarItems(xml).filter((item) => item.uid === req.uid);
}

async function seriesMaster(item: CalendarItem, uid: string, ews: Ews): Promise<CalendarItem> {
  const xml = await call(ews, `<m:GetItem>${SHAPE}<m:ItemIds><t:RecurringMasterItemId OccurrenceId="${escapeXml(item.id)}"/></m:ItemIds></m:GetItem>`);
  const master = calendarItems(xml)[0];
  if (!master) throw new Error("Exchange did not return the series of this invitation.");
  if (master.uid !== uid) throw new Error("The series Exchange returned is not this invitation.");
  return master;
}

const inSeries = (c: CalendarItem): boolean => c.type === "Occurrence" || c.type === "Exception";

/**
 * Removes the copy of a declined invitation that Exchange placed on the calendar: only items whose UID is the
 * invitation's, found around its time. A recurring invitation removes its series master; an invitation for one meeting
 * of a series is refused, so the series stays. Items move to Deleted Items and nothing goes to the organizer. Items the
 * principal organizes are refused. A second run finds nothing and says so.
 */
export async function removeDeclinedCopy(req: DeskDeclinedCopyRequest, ews: Ews): Promise<DeskWriteResult> {
  const copies = await findCopies(req, ews);
  if (copies.some((c) => c.organizer)) throw new Refusal(ORGANIZED);
  const singles = copies.filter((c) => !inSeries(c));
  const occurrence = copies.find(inSeries);
  if (occurrence && !req.recurring) throw new Refusal("This invitation is for one meeting of a series, so the Desk does not remove it from Exchange.");
  const master = occurrence ? await seriesMaster(occurrence, req.uid, ews) : undefined;
  if (master?.organizer) throw new Refusal(ORGANIZED);
  const targets = new Set([...singles, ...(master ? [master] : [])].map((c) => c.id));
  if (targets.size === 0) return { id: req.uid, message: "Your Exchange calendar holds no copy of this invitation." };
  const ids = [...targets].map((id) => `<t:ItemId Id="${escapeXml(id)}"/>`).join("");
  await call(ews, `<m:DeleteItem DeleteType="MoveToDeletedItems" SendMeetingCancellations="SendToNone"><m:ItemIds>${ids}</m:ItemIds></m:DeleteItem>`);
  return { id: req.uid, message: "Exchange's tentative copy is removed from your calendar." };
}

export function decodeKeychainPassword(raw: string): string {
  if (!/^(?:[0-9a-f]{2})+$/i.test(raw)) return raw;
  try {
    const decoded = new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(raw.match(/../g) ?? [], (h) => Number.parseInt(h, 16)));
    return /[^\x00-\x7F]/.test(decoded) ? decoded : raw;
  } catch {
    return raw;
  }
}

const icalConfigPath = (): string => join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "ical", "config.json");

/** Reads one account of the `ical` CLI's Exchange config, with its password from the keychain item `ical exchange config` stores. */
export async function icalAccount(name: string, run: Runner, path = icalConfigPath()): Promise<EwsAccount> {
  let config: unknown;
  try {
    config = JSON.parse(await readFile(path, "utf8"));
  } catch {
    throw new Refusal("The ical config could not be read.");
  }
  const accounts = isRecord(config) && Array.isArray(config.accounts) ? config.accounts : [];
  const account: unknown = accounts.find((a: unknown) => isRecord(a) && a.name === name);
  if (!isRecord(account) || typeof account.url !== "string" || typeof account.username !== "string") throw new Refusal(`There is no Exchange account ${name} in the ical config.`);
  if (!account.url.startsWith("https://")) throw new Refusal("The Exchange URL does not use HTTPS.");
  const result = await run(["security", "find-generic-password", "-a", "ical-calendar", "-s", `ical-exchange-${name}`, "-w"]);
  const pass = decodeKeychainPassword(result.stdout.replace(/\n$/, ""));
  if (result.code !== 0 || !pass) throw new Refusal(`The Exchange password could not be read from the keychain${result.stderr ? `: ${lastLine(result.stderr)}` : "."}`);
  const user = typeof account.domain === "string" && account.domain ? `${account.domain}\\${account.username}` : account.username;
  return { url: account.url, user, pass };
}

export type Post = (url: string, init: RequestInit) => Promise<Response>;

export function ewsTransport(account: EwsAccount, timeoutMs = 20_000, post: Post = fetch): Ews {
  const authorization = `Basic ${Buffer.from(`${account.user}:${account.pass}`).toString("base64")}`;
  return async (body) => {
    const res = await post(account.url, { method: "POST", headers: { "content-type": "text/xml; charset=utf-8", authorization }, body, signal: AbortSignal.timeout(timeoutMs) });
    const xml = await res.text();
    if (!xml.includes("Envelope")) throw new Error(`Exchange answered HTTP ${res.status} without a SOAP envelope.`);
    return xml;
  };
}
