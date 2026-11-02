import { describe, expect, it } from "bun:test";
import { fromRawExchange } from "../src/calendar-availability";
import { parseIcs } from "../src/ics";

const from = "2026-11-03T00:00:00Z";
const to = "2026-11-04T00:00:00Z";
const event = (legacyFreeBusyStatus: string, allDay = false) => ({ id: legacyFreeBusyStatus, start: allDay ? from : "2026-11-03T10:00:00Z", end: allDay ? to : "2026-11-03T11:00:00Z", allDay, title: "Owned example", legacyFreeBusyStatus, propertiesLoaded: true });
const report = (events: unknown[]) => ({ version: 1, from, to, calendar: { id: "owned-calendar", name: "Calendar" }, complete: true, moreAvailable: false, problems: [], events });

describe("qualified availability adapters", () => {
  it("uses raw EWS status rather than display kind and preserves actual all-day intervals", () => {
    const output = fromRawExchange(report([event("Free", true), event("Busy", true), event("OOF"), event("Tentative"), event("NoData"), event("WorkingElsewhere")]));
    expect(output.events?.map(value => value.availability?.status)).toEqual(["free", "busy", "busy", "unknown", "unknown", "unknown"]);
    expect(output.events?.[0]).toMatchObject({ start: from, end: to, allDay: true, calendarId: "owned-calendar" });
    expect(output.calendarCoverage?.status).toBe("complete");
  });
  it("keeps empty, truncated and failed-property windows distinct", () => {
    expect(fromRawExchange(report([])).calendarCoverage?.status).toBe("complete");
    expect(fromRawExchange({ ...report([]), moreAvailable: true }).calendarCoverage?.status).toBe("partial");
    expect(fromRawExchange({ ...report([]), moreAvailable: null }).calendarCoverage?.status).toBe("partial");
    const partial = fromRawExchange(report([{ ...event("Busy"), propertiesLoaded: false }]));
    expect(partial.calendarCoverage?.status).toBe("partial");
    expect(partial.events?.[0]?.availability?.status).toBe("unknown");
    expect(() => fromRawExchange(report([{ ...event("Busy"), end: "invalid" }]))).toThrow();
  });
  it("refuses complete coverage for unsupported availability-bearing components", () => {
    for (const component of ["VFREEBUSY", "VAVAILABILITY"]) {
      const content = ["BEGIN:VCALENDAR", `BEGIN:${component}`, "UID:owned-unsupported", "DTSTART:20261103T000000Z", "DTEND:20261104T000000Z", "FREEBUSY:20261103T100000Z/20261103T110000Z", `END:${component}`, "END:VCALENDAR"].join("\n");
      expect(parseIcs(content, { from: Date.parse(from), to: Date.parse(to) }).complete).toBe(false);
    }
  });
  it("keeps absent transparency unknown", () => {
    const content = ["BEGIN:VCALENDAR", "BEGIN:VEVENT", "UID:owned-missing", "SUMMARY:Owned entry", "DTSTART:20261103T100000Z", "DTEND:20261103T110000Z", "END:VEVENT", "END:VCALENDAR"].join("\n");
    expect(parseIcs(content, { from: Date.parse(from), to: Date.parse(to) }).events[0]?.availability?.status).toBe("unknown");
  });
  it("refuses complete coverage when a moved recurring occurrence cannot be represented", () => {
    const content = ["BEGIN:VCALENDAR", "BEGIN:VEVENT", "UID:owned-override", "RECURRENCE-ID:20261103T090000Z", "SUMMARY:Owned moved occurrence", "DTSTART:20261103T100000Z", "DTEND:20261103T110000Z", "TRANSP:OPAQUE", "END:VEVENT", "END:VCALENDAR"].join("\n");
    expect(parseIcs(content, { from: Date.parse(from), to: Date.parse(to) }).complete).toBe(false);
  });
  it("retains RFC transparency and unknown tentative status without all-day guesses", () => {
    const content = ["BEGIN:VCALENDAR", ...["TRANSPARENT", "OPAQUE", "INVALID"].flatMap((value, index) => ["BEGIN:VEVENT", `UID:${index}`, "DTSTART;VALUE=DATE:20261103", "DTEND;VALUE=DATE:20261104", `TRANSP:${value}`, "SUMMARY:Owned all-day", "END:VEVENT"]), "END:VCALENDAR"].join("\n");
    const parsed = parseIcs(content, { from: Date.parse(from), to: Date.parse(to) });
    expect(parsed.complete).toBe(true);
    expect(parsed.events.map(value => value.availability?.status)).toEqual(["free", "busy", "unknown"]);
    expect(parsed.events.every(value => value.end !== undefined)).toBe(true);
    expect(parseIcs("invalid", { from: Date.parse(from), to: Date.parse(to) }).complete).toBe(false);
  });
});
