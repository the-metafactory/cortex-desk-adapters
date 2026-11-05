import type { DeskInviteReplyRequest, DeskMailInvitation, DeskPartStat } from "./contract";
import { isRecord } from "./guards";
import { parseProperty, parseTime, toInstant, unescapeText, unfold, type IcsProperty } from "./ics";
import { Refusal } from "./writers";

const MAX_TEXT = 300;
const MESSAGE_ID = /^[^\s<>]{1,512}$/;
const ACCOUNT = /^[\w.-]{1,64}$/;
const REQUEST_ID = /^[\w-]{8,64}$/;
const UID = /^[^\r\n]{1,1000}$/;
const ADDRESS = /^[^\s<>,@:]+@[^\s<>,@:]+$/;
const PARTSTATS: readonly DeskPartStat[] = ["NEEDS-ACTION", "ACCEPTED", "DECLINED", "TENTATIVE", "DELEGATED"];
const DAY_MS = 86_400_000;

const WINDOWS_ZONES: Record<string, string> = {
  "W. Europe Standard Time": "Europe/Zurich",
  "Central Europe Standard Time": "Europe/Budapest",
  "Central European Standard Time": "Europe/Warsaw",
  "Romance Standard Time": "Europe/Paris",
  "GMT Standard Time": "Europe/London",
  "Greenwich Standard Time": "Atlantic/Reykjavik",
  "E. Europe Standard Time": "Europe/Chisinau",
  "FLE Standard Time": "Europe/Helsinki",
  "GTB Standard Time": "Europe/Bucharest",
  "Eastern Standard Time": "America/New_York",
  "Central Standard Time": "America/Chicago",
  "Mountain Standard Time": "America/Denver",
  "Pacific Standard Time": "America/Los_Angeles",
  UTC: "UTC",
  "Coordinated Universal Time": "UTC",
};

const bare = (id: string): string => id.trim().replace(/^<|>$/g, "");
const clip = (text: string, max = MAX_TEXT): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text);
const oneLine = (text: string): string => text.replace(/\s+/g, " ").trim();

interface Component {
  name: string;
  lines: string[];
}

/** The top-level components of one VCALENDAR: VEVENT and VTIMEZONE keep their raw unfolded lines, nested blocks included. */
function components(ics: string): { method?: string; items: Component[] } {
  const items: Component[] = [];
  let method: string | undefined;
  let depth = 0;
  let current: Component | null = null;
  for (const line of unfold(ics)) {
    const begin = /^BEGIN:(.+)$/i.exec(line)?.[1]?.trim().toUpperCase();
    const end = /^END:(.+)$/i.exec(line)?.[1]?.trim().toUpperCase();
    if (begin) {
      depth += 1;
      if (depth === 2) current = { name: begin, lines: [] };
    }
    if (current) current.lines.push(line);
    if (depth === 1 && !begin && !end) {
      const prop = parseProperty(line);
      if (prop?.name === "METHOD") method = prop.value.trim().toUpperCase();
    }
    if (end) {
      if (depth === 2 && current) {
        items.push(current);
        current = null;
      }
      depth = Math.max(0, depth - 1);
    }
  }
  return { ...(method ? { method } : {}), items };
}

/** The content lines of the component itself, not of a nested VALARM. */
function ownLines(component: Component): string[] {
  const out: string[] = [];
  let depth = 0;
  for (const line of component.lines) {
    if (/^BEGIN:/i.test(line)) depth += 1;
    else if (/^END:/i.test(line)) depth -= 1;
    else if (depth === 1) out.push(line);
  }
  return out;
}

const ownProperties = (component: Component): IcsProperty[] => ownLines(component).flatMap((line) => parseProperty(line) ?? []);

const mailto = (value: string): string | null => {
  const address = value.trim().replace(/^mailto:/i, "").trim().toLowerCase();
  return ADDRESS.test(address) ? address : null;
};

function instantOf(prop: IcsProperty | undefined): { at: number; allDay: boolean } | null {
  if (!prop) return null;
  const tzid = prop.params.TZID;
  const zone = tzid ? WINDOWS_ZONES[tzid] ?? tzid : undefined;
  const time = parseTime({ ...prop, params: { ...prop.params, ...(zone ? { TZID: zone } : {}) } });
  if (!time) return null;
  return { at: toInstant(time), allDay: time.allDay };
}

const DURATION = /^P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/;

export function durationMs(value: string): number | null {
  const m = DURATION.exec(value.trim());
  if (!m || value.trim() === "P" || value.trim().endsWith("T")) return null;
  const [w, d, h, mi, s] = [m[1], m[2], m[3], m[4], m[5]].map((v) => Number(v ?? 0));
  return ((((w ?? 0) * 7 + (d ?? 0)) * 24 + (h ?? 0)) * 60 + (mi ?? 0)) * 60_000 + (s ?? 0) * 1000;
}

/** The master VEVENT of a request: the one without RECURRENCE-ID, else the first. */
function masterEvent(items: Component[]): Component | undefined {
  const events = items.filter((c) => c.name === "VEVENT");
  return events.find((e) => !ownProperties(e).some((p) => p.name === "RECURRENCE-ID")) ?? events[0];
}

/** The UID and SEQUENCE of an iTIP METHOD:REPLY, as the principal's client sent it; null for anything else. */
export function parseReply(ics: string): { uid: string; sequence: number } | null {
  const { method, items } = components(ics);
  if (method !== "REPLY") return null;
  const event = masterEvent(items);
  if (!event) return null;
  const props = ownProperties(event);
  const uid = props.find((p) => p.name === "UID")?.value.trim();
  if (!uid || !UID.test(uid)) return null;
  const sequence = Number(props.find((p) => p.name === "SEQUENCE")?.value.trim() ?? "0");
  return { uid: clip(uid, 1000), sequence: Number.isInteger(sequence) && sequence >= 0 ? sequence : 0 };
}

/**
 * Reads a calendar invitation (iTIP METHOD:REQUEST) for the Desk. `self` holds the account's own addresses, to find the
 * principal among the attendees. Anything that is not a well-formed request with a UID, a start and an organizer is null.
 */
export function parseInvitation(ics: string, self: readonly string[]): DeskMailInvitation | null {
  const { method, items } = components(ics);
  if (method !== "REQUEST") return null;
  const event = masterEvent(items);
  if (!event) return null;
  const props = ownProperties(event);
  const one = (name: string): IcsProperty | undefined => props.find((p) => p.name === name);
  const uid = one("UID")?.value.trim();
  const organizerProp = one("ORGANIZER");
  const organizer = organizerProp ? mailto(organizerProp.value) : null;
  const start = instantOf(one("DTSTART"));
  if (!uid || !UID.test(uid) || !organizer || !organizerProp || !start) return null;
  const endProp = instantOf(one("DTEND"));
  const duration = one("DURATION") ? durationMs(one("DURATION")?.value ?? "") : null;
  const end = endProp ? endProp.at : duration !== null ? start.at + duration : start.allDay ? start.at + DAY_MS : undefined;
  if (end !== undefined && end < start.at) return null;
  const sequence = Number(one("SEQUENCE")?.value.trim() ?? "0");
  const own = new Set(self.map((a) => a.toLowerCase()));
  const attendees = props.filter((p) => p.name === "ATTENDEE");
  const me = attendees.find((a) => {
    const address = mailto(a.value);
    return address !== null && own.has(address);
  });
  const meAddress = me ? mailto(me.value) : null;
  const status = (me?.params.PARTSTAT ?? "NEEDS-ACTION").toUpperCase() as DeskPartStat;
  const summary = oneLine(unescapeText(one("SUMMARY")?.value ?? "")) || "(no title)";
  const location = oneLine(unescapeText(one("LOCATION")?.value ?? ""));
  const organizerName = organizerProp.params.CN ? oneLine(organizerProp.params.CN) : "";
  return {
    method: "REQUEST",
    uid: clip(uid, 1000),
    sequence: Number.isInteger(sequence) && sequence >= 0 ? sequence : 0,
    summary: clip(summary),
    start: new Date(start.at).toISOString(),
    ...(end !== undefined ? { end: new Date(end).toISOString() } : {}),
    ...(start.allDay ? { allDay: true } : {}),
    ...(location ? { location: clip(location) } : {}),
    organizer: { address: organizer, ...(organizerName ? { name: clip(organizerName, 200) } : {}) },
    ...(me && meAddress ? { attendee: { address: meAddress, status: PARTSTATS.includes(status) ? status : "NEEDS-ACTION", ...(me.params.RSVP ? { rsvp: me.params.RSVP.toUpperCase() === "TRUE" } : {}) } } : {}),
    ...(props.some((p) => p.name === "RRULE" || p.name === "RDATE") ? { recurring: true } : {}),
    attendees: attendees.length,
  };
}

/** Folds one content line at 75 octets, as RFC 5545 asks, without splitting a UTF-8 character. */
export function foldLine(line: string): string {
  const encoder = new TextEncoder();
  const out: string[] = [];
  let current = "";
  let size = 0;
  for (const ch of line) {
    const bytes = encoder.encode(ch).length;
    const limit = out.length === 0 ? 75 : 74;
    if (size + bytes > limit) {
      out.push(current);
      current = "";
      size = 0;
    }
    current += ch;
    size += bytes;
  }
  out.push(current);
  return out.join("\r\n ");
}

const icsStamp = (at: number): string => new Date(at).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");

const COPIED = ["UID", "SEQUENCE", "DTSTART", "DTEND", "DURATION", "RECURRENCE-ID", "ORGANIZER", "SUMMARY", "LOCATION"];

const PARTSTAT: Record<DeskInviteReplyRequest["reply"], DeskPartStat> = { accept: "ACCEPTED", decline: "DECLINED" };

/**
 * The iTIP REPLY (RFC 5546) for one invitation: the request's VTIMEZONEs, then a VEVENT with the request's UID, SEQUENCE,
 * times, ORGANIZER and SUMMARY, a fresh DTSTAMP and one ATTENDEE, the principal, with the answer as PARTSTAT.
 * It refuses a request that does not list `attendee`.
 */
export function buildReply(ics: string, input: { attendee: string; reply: DeskInviteReplyRequest["reply"]; now: number }): string {
  const { method, items } = components(ics);
  if (method !== "REQUEST") throw new Refusal("The invitation is not a meeting request, so it cannot be answered.");
  const event = masterEvent(items);
  if (!event) throw new Refusal("The invitation holds no event.");
  const self = input.attendee.toLowerCase();
  const own = ownLines(event);
  const named = (line: string): string => parseProperty(line)?.name ?? "";
  const me = own.find((line) => named(line) === "ATTENDEE" && mailto(parseProperty(line)?.value ?? "") === self);
  if (!me) throw new Refusal("You are not listed as an attendee of this invitation, so the Desk does not answer it.");
  const meProp = parseProperty(me);
  const cn = meProp?.params.CN ? `;CN="${meProp.params.CN.replace(/"/g, "")}"` : "";
  const attendee = `ATTENDEE;PARTSTAT=${PARTSTAT[input.reply]}${cn}:${meProp?.value.trim() ?? `mailto:${self}`}`;
  const copied = own.filter((line) => COPIED.includes(named(line)));
  const zones = items.filter((c) => c.name === "VTIMEZONE").flatMap((c) => c.lines);
  const lines = [
    "BEGIN:VCALENDAR",
    "PRODID:-//MetaFactory//Cortex Desk//EN",
    "VERSION:2.0",
    "METHOD:REPLY",
    ...zones,
    "BEGIN:VEVENT",
    ...copied,
    attendee,
    `DTSTAMP:${icsStamp(input.now)}`,
    "END:VEVENT",
    "END:VCALENDAR",
  ];
  return `${lines.map(foldLine).join("\r\n")}\r\n`;
}

export const base64Lines = (text: string): string => (Buffer.from(text, "utf8").toString("base64").match(/.{1,76}/g) ?? []).join("\r\n");

const asciiOnly = (text: string): boolean => [...text].every((ch) => ch.charCodeAt(0) >= 32 && ch.charCodeAt(0) < 127);

/** An RFC 2047 encoded word when the text is not plain printable ASCII. */
export const headerWord = (text: string): string => (asciiOnly(text) ? text : `=?UTF-8?B?${Buffer.from(text, "utf8").toString("base64")}?=`);

/** A From header value: the address alone, or with the display name quoted or encoded. */
export function senderHeader(from: string, fromName?: string): string {
  const name = fromName?.replace(/["\\]/g, "");
  return name ? `${asciiOnly(name) ? `"${name}"` : headerWord(name)} <${from}>` : from;
}

export interface ReplyMessageInput {
  from: string;
  fromName?: string;
  to: string;
  reply: DeskInviteReplyRequest["reply"];
  summary: string;
  ics: string;
  inReplyTo: string;
  messageId: string;
  boundary: string;
  date: Date;
}

const WORD: Record<DeskInviteReplyRequest["reply"], { subject: string; text: string }> = {
  accept: { subject: "Accepted", text: "has accepted" },
  decline: { subject: "Declined", text: "has declined" },
};

/** The iMIP message (RFC 6047) carrying one REPLY: a short text part and the text/calendar part with method=REPLY. */
export function replyMessage(input: ReplyMessageInput): string {
  const word = WORD[input.reply];
  const who = input.fromName ? `${input.fromName} (${input.from})` : input.from;
  return [
    `From: ${senderHeader(input.from, input.fromName)}`,
    `To: ${input.to}`,
    `Subject: ${headerWord(`${word.subject}: ${input.summary}`)}`,
    `Date: ${input.date.toUTCString().replace("GMT", "+0000")}`,
    `Message-ID: <${input.messageId}>`,
    `In-Reply-To: <${input.inReplyTo}>`,
    `References: <${input.inReplyTo}>`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/alternative; boundary="${input.boundary}"`,
    "",
    `--${input.boundary}`,
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: base64",
    "",
    base64Lines(`${who} ${word.text} the invitation "${input.summary}".\n`),
    `--${input.boundary}`,
    "Content-Type: text/calendar; charset=utf-8; method=REPLY",
    "Content-Transfer-Encoding: base64",
    "",
    base64Lines(input.ics),
    `--${input.boundary}--`,
    "",
  ].join("\r\n");
}

/** Parses `{ action: "invite-reply", account, messageId, uid, reply: "accept" | "decline", requestId }`, refusing anything else. */
export function readInviteReplyRequest(text: string): DeskInviteReplyRequest {
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Refusal("The request is not valid JSON.");
  }
  if (!isRecord(body) || body.action !== "invite-reply") throw new Refusal("This command only answers invitations.");
  const { account, messageId, uid, reply, requestId } = body;
  if (typeof account !== "string" || !ACCOUNT.test(account)) throw new Refusal("The request names no valid account.");
  if (typeof messageId !== "string" || !MESSAGE_ID.test(bare(messageId))) throw new Refusal("The request has no valid Message-ID.");
  if (typeof uid !== "string" || !UID.test(uid)) throw new Refusal("The request has no valid invitation UID.");
  if (reply !== "accept" && reply !== "decline") throw new Refusal("The answer must be accept or decline.");
  if (typeof requestId !== "string" || !REQUEST_ID.test(requestId)) throw new Refusal("The request id is not 8 to 64 letters, digits, dashes or underscores.");
  return { action: "invite-reply", account, messageId: bare(messageId), uid, reply, requestId };
}

export interface CalendarPartNode {
  part?: string;
  type?: string;
  childNodes?: CalendarPartNode[];
}

/** The first text/calendar part of a body structure (an application/ics attachment if there is none), or undefined. */
export function calendarPart(node: CalendarPartNode | undefined): string | undefined {
  const leaves = (n: CalendarPartNode | undefined): CalendarPartNode[] => (!n ? [] : n.childNodes?.length ? n.childNodes.flatMap(leaves) : [n]);
  const all = leaves(node);
  const found = all.find((p) => (p.type ?? "").toLowerCase() === "text/calendar") ?? all.find((p) => (p.type ?? "").toLowerCase() === "application/ics");
  return found ? found.part ?? "1" : undefined;
}
