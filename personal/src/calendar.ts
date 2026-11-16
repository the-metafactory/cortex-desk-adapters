import { eventPeople } from "../../src/attendees";
import type { DeskSourceEvent } from "../../src/contract";

/** One event from `ical exchange list --compact --format json`. */
export interface ExchangeEvent {
  date: string;
  startTime?: string | null;
  endTime?: string | null;
  isAllDay?: boolean;
  title: string;
  location?: string | null;
  meetingLink?: string | null;
  /** The organizer's address, or null. */
  organizer?: string | null;
  /** Required and optional attendees. `email` falls back to the attendee's name when EWS has no address. */
  attendees?: { email?: string | null }[] | null;
}

/** One event from `ical read --format json` (macOS Calendar). */
export interface MacEvent {
  title: string;
  calendar: string;
  date: string;
  start_at?: string | null;
  end_at?: string | null;
  urls?: string[];
}

/** "2026-10-30" + "13:00" read as local time → ISO 8601 (UTC). */
export function localIso(date: string, time = "00:00"): string {
  return new Date(`${date}T${time}:00`).toISOString();
}

const isOnline = (location: string | null | undefined, link: string | null | undefined): boolean =>
  Boolean(link) || /teams|zoom|webex|online/i.test(location ?? "");

export function fromExchange(e: ExchangeEvent): DeskSourceEvent {
  const allDay = Boolean(e.isAllDay) || !e.startTime;
  return {
    id: `${e.date}|${e.startTime ?? ""}|${e.title}`,
    start: localIso(e.date, allDay ? "00:00" : e.startTime ?? "00:00"),
    ...(!allDay && e.endTime ? { end: localIso(e.date, e.endTime) } : {}),
    ...(allDay ? { allDay: true } : {}),
    title: e.title,
    calendar: "Exchange",
    ...(e.location ? { location: e.location } : {}),
    ...(isOnline(e.location, e.meetingLink) ? { online: true } : {}),
    ...(e.meetingLink ? { url: e.meetingLink } : {}),
    ...eventPeople(e.organizer, (Array.isArray(e.attendees) ? e.attendees : []).map((a) => a?.email)),
  };
}

export function fromMac(e: MacEvent): DeskSourceEvent {
  const allDay = !e.start_at;
  const url = e.urls?.find((u) => /^https?:/.test(u));
  return {
    id: `${e.calendar}|${e.date}|${e.start_at ?? ""}|${e.title}`,
    start: localIso(e.date, e.start_at ?? "00:00"),
    ...(!allDay && e.end_at ? { end: localIso(e.date, e.end_at) } : {}),
    ...(allDay ? { allDay: true } : {}),
    title: e.title,
    calendar: e.calendar,
    ...(url ? { url } : {}),
  };
}

/** The same event listed twice collapses to one; the result is sorted by start. */
export function dedupe(events: DeskSourceEvent[]): DeskSourceEvent[] {
  const seen = new Map<string, DeskSourceEvent>();
  for (const e of events) if (!seen.has(e.id)) seen.set(e.id, e);
  return [...seen.values()].sort((a, b) => a.start.localeCompare(b.start));
}
