import { z } from "zod";
import type { DeskSourceEvent, DeskSourceOutput } from "./contract";

const instant = z.iso.datetime({ offset: true });
export const ExchangeAvailabilitySchema = z.object({
  version: z.literal(1),
  from: instant,
  to: instant,
  calendar: z.object({ id: z.string().min(1), name: z.string().min(1) }),
  complete: z.boolean(),
  moreAvailable: z.boolean().nullable(),
  problems: z.array(z.string()),
  events: z.array(z.object({ id: z.string().min(1), start: instant, end: instant, allDay: z.boolean(), title: z.string(), legacyFreeBusyStatus: z.string().min(1), propertiesLoaded: z.boolean() }).refine(event => Date.parse(event.end) > Date.parse(event.start), "event end must be after start")),
}).refine(report => Date.parse(report.to) > Date.parse(report.from), "query end must be after start");

export function fromRawExchange(input: unknown): DeskSourceOutput {
  const report = ExchangeAvailabilitySchema.parse(input);
  const events = report.events.map((event): DeskSourceEvent => ({
    id: event.id,
    start: event.start,
    end: event.end,
    title: event.title || "(No Title)",
    allDay: event.allDay,
    calendar: "Exchange",
    calendarId: report.calendar.id,
    availability: {
      status: !event.propertiesLoaded ? "unknown" : event.legacyFreeBusyStatus === "Free" ? "free" : ["Busy", "OOF"].includes(event.legacyFreeBusyStatus) ? "busy" : "unknown",
      provenance: `EWS.Appointment.LegacyFreeBusyStatus.${event.legacyFreeBusyStatus}`,
    },
  }));
  const complete = report.complete && report.moreAvailable === false && report.problems.length === 0 && report.events.every(event => event.propertiesLoaded && Date.parse(event.start) < Date.parse(report.to) && Date.parse(event.end) > Date.parse(report.from));
  return { capabilities: ["calendar"], events, calendarCoverage: { from: report.from, to: report.to, calendars: [{ id: report.calendar.id, name: "Exchange" }], status: complete ? "complete" : "partial", provenance: "EWS.CalendarView.MoreAvailable" } };
}
