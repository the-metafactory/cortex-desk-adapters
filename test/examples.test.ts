import { describe, expect, it } from "bun:test";
import { parseIcs, parseProperty, toInstant, parseTime } from "../src/ics";
import { icsWindow, readIcs } from "../src/ics-source";
import { firstParagraph, textPart, toDeskMail } from "../src/imap-mail";
import { ntfyRequest, readPush } from "../src/ntfy";

const cal = (...events: string[][]): string =>
  ["BEGIN:VCALENDAR", ...events.flatMap((e) => ["BEGIN:VEVENT", ...e, "END:VEVENT"]), "END:VCALENDAR"].join("\r\n");

const window = (fromIso: string, days: number) => ({ from: Date.parse(fromIso), to: Date.parse(fromIso) + days * 86_400_000 });

describe("desk-ics", () => {
  it("reads a UTC event, unfolds lines and unescapes text", () => {
    const text = cal(["UID:a", "DTSTART:20261102T130000Z", "DTEND:20261102T140000Z", "SUMMARY:Budget\\, part ", " two", "LOCATION:Room 1", "URL:https://meet.example.org/x"]);
    expect(parseIcs(text, window("2026-11-02T00:00:00Z", 1)).events).toEqual([
      { id: "a", start: "2026-11-02T13:00:00.000Z", end: "2026-11-02T14:00:00.000Z", availability: { status: "unknown", provenance: "RFC5545.TRANSP.UNKNOWN" }, title: "Budget, part two", location: "Room 1", url: "https://meet.example.org/x" },
    ]);
  });

  it("converts a TZID time to UTC on both sides of a daylight-saving change", () => {
    const at = (value: string) => toInstant(parseTime(parseProperty(`DTSTART;TZID=Europe/Zurich:${value}`) ?? { name: "", params: {}, value: "" }) ?? { wall: { y: 0, mo: 0, d: 0, h: 0, mi: 0, s: 0 }, allDay: false, utc: false });
    expect(new Date(at("20261023T090000")).toISOString()).toBe("2026-10-23T07:00:00.000Z");
    expect(new Date(at("20261102T090000")).toISOString()).toBe("2026-11-02T08:00:00.000Z");
  });

  it("expands daily and weekly rules inside the window, minus EXDATE", () => {
    const text = cal(
      ["UID:d", "DTSTART:20260105T090000Z", "RRULE:FREQ=DAILY", "EXDATE:20261103T090000Z", "SUMMARY:Daily"],
      ["UID:w", "DTSTART:20260105T140000Z", "RRULE:FREQ=WEEKLY;BYDAY=MO,WE", "SUMMARY:Weekly"],
    );
    const starts = parseIcs(text, window("2026-11-02T00:00:00Z", 3)).events.map((e) => `${e.title} ${e.start}`);
    expect(starts).toEqual([
      "Daily 2026-11-02T09:00:00.000Z",
      "Weekly 2026-11-02T14:00:00.000Z",
      "Daily 2026-11-04T09:00:00.000Z",
      "Weekly 2026-11-04T14:00:00.000Z",
    ]);
  });

  it("stops a rule at COUNT and UNTIL", () => {
    const text = cal(
      ["UID:c", "DTSTART:20261101T090000Z", "RRULE:FREQ=DAILY;COUNT=2", "SUMMARY:Count"],
      ["UID:u", "DTSTART:20261101T100000Z", "RRULE:FREQ=DAILY;UNTIL=20261102T235959Z", "SUMMARY:Until"],
    );
    expect(parseIcs(text, window("2026-11-01T00:00:00Z", 5)).events.map((e) => `${e.title} ${e.start.slice(0, 10)}`)).toEqual([
      "Count 2026-11-01", "Until 2026-11-01", "Count 2026-11-02", "Until 2026-11-02",
    ]);
  });

  it("marks a date-only event all day and skips cancelled events", () => {
    const text = cal(["UID:x", "DTSTART;VALUE=DATE:20261102", "SUMMARY:Holiday"], ["UID:y", "DTSTART:20261102T100000Z", "STATUS:CANCELLED", "SUMMARY:Gone"]);
    const [only, ...rest] = parseIcs(text, window("2026-11-01T00:00:00Z", 3)).events;
    expect(rest).toEqual([]);
    expect(only?.allDay).toBe(true);
    expect(only?.title).toBe("Holiday");
  });

  it("keeps only events overlapping the requested window", () => {
    const text = cal(["UID:old", "DTSTART:20261101T090000Z", "SUMMARY:Old"], ["UID:next", "DTSTART:20261103T090000Z", "SUMMARY:Next"], ["UID:current", "DTSTART:20261102T090000Z", "SUMMARY:Current"]);
    expect(parseIcs(text, window("2026-11-02T00:00:00Z", 1)).events.map((e) => e.title)).toEqual(["Current"]);
  });

  it("handles COUNT series whose current occurrence is past the first thousand", () => {
    const text = cal(["UID:long", "DTSTART:20200101T090000Z", "RRULE:FREQ=DAILY;COUNT=5000", "SUMMARY:Long"]);
    expect(parseIcs(text, window("2026-11-02T00:00:00Z", 1)).events).toHaveLength(1);
  });

  it("applies BYDAY to daily rules and rejects unsupported or malformed rules", () => {
    const text = cal(["UID:daily", "DTSTART:20261102T090000Z", "RRULE:FREQ=DAILY;BYDAY=MO,WE", "SUMMARY:Daily"]);
    expect(parseIcs(text, window("2026-11-02T00:00:00Z", 3)).events).toHaveLength(2);
    for (const bad of ["FREQ=DAILY;INTERVAL=0", "FREQ=DAILY;COUNT=no", "FREQ=WEEKLY;WKST=SU", "FREQ=DAILY;UNTIL=nonsense"]) {
      expect(parseIcs(cal(["DTSTART:20261102T090000Z", `RRULE:${bad}`, "SUMMARY:Bad"]), window("2026-11-02T00:00:00Z", 3))).toEqual({ events: [], skipped: 1, complete: false });
    }
  });

  it("rejects invalid dates and unknown time zones", () => {
    for (const time of ["DTSTART:20261301T090000Z", "DTSTART:20260230T090000Z", "DTSTART;TZID=Unknown/Zone:20261102T090000"]) {
      expect(parseIcs(cal([time, "SUMMARY:Bad"]), window("2026-11-02T00:00:00Z", 3))).toEqual({ events: [], skipped: 1, complete: false });
    }
  });

  it("uses the first occurrence of a repeated wall time", () => {
    const text = cal(["UID:fold", "DTSTART;TZID=Europe/Zurich:20261025T023000", "SUMMARY:Repeated"]);
    expect(parseIcs(text, window("2026-10-25T00:00:00Z", 1)).events[0]?.start).toBe("2026-10-25T00:30:00.000Z");
  });

  it("ends all-day occurrences at the next local midnight across DST", () => {
    const prior = process.env.TZ;
    process.env.TZ = "Europe/Zurich";
    try {
      const text = cal(["UID:day", "DTSTART;VALUE=DATE:20260329", "SUMMARY:Day"], ["UID:recurring", "DTSTART;VALUE=DATE:20260328", "RRULE:FREQ=DAILY;COUNT=2", "SUMMARY:Recurring"]);
      const events = parseIcs(text, { from: Date.parse("2026-03-29T00:00:00+01:00"), to: Date.parse("2026-03-30T00:00:00+02:00") }).events;
      expect(events).toHaveLength(2);
      expect(events.every((e) => e.end === "2026-03-29T22:00:00.000Z")).toBe(true);
      expect(parseIcs(text, { from: Date.parse("2026-03-30T00:00:00+02:00"), to: Date.parse("2026-03-31T00:00:00+02:00") }).events).toEqual([]);
    } finally {
      if (prior === undefined) delete process.env.TZ;
      else process.env.TZ = prior;
    }
  });

  it("counts an event it cannot read instead of guessing", () => {
    const text = cal(["UID:m", "DTSTART:20261101T090000Z", "RRULE:FREQ=MONTHLY", "SUMMARY:Monthly"], ["UID:n", "SUMMARY:No start"]);
    expect(parseIcs(text, window("2026-11-01T00:00:00Z", 3))).toEqual({ events: [], skipped: 2, complete: false });
  });

  it("refuses a link other than https and a missing file", async () => {
    await expect(readIcs("http://calendar.example.org/a.ics")).rejects.toThrow("Only https URLs and local files are read.");
    await expect(readIcs("/does/not/exist.ics")).rejects.toThrow("There is no calendar file");
  });

  it("shows the bundled example calendar today", async () => {
    const now = Date.now();
    const { events, skipped } = parseIcs(await readIcs(`${import.meta.dir}/../examples/calendar.ics`), icsWindow(now, 7));
    expect(skipped).toBe(0);
    expect(events.some((e) => e.title === "Plan the day" && new Date(e.start).toDateString() === new Date(now).toDateString())).toBe(true);
  });
});

describe("desk-imap", () => {
  it("picks the first plain-text part that is not an attachment", () => {
    expect(textPart({ type: "multipart/mixed", childNodes: [
      { type: "multipart/alternative", childNodes: [{ part: "1.1", type: "text/plain" }, { part: "1.2", type: "text/html" }] },
      { part: "2", type: "text/plain", disposition: "attachment" },
    ] })).toBe("1.1");
    expect(textPart({ type: "text/plain" })).toBe("1");
    expect(textPart({ type: "text/html" })).toBeNull();
  });

  it("takes the first paragraph after a greeting and skips quoted lines", () => {
    expect(firstParagraph("Hi Ada,\n\nCould you look at the\nbudget?\n\n> old text\n")).toBe("Could you look at the budget?");
  });

  it("maps an envelope to a Desk mail item and drops one without a sender", () => {
    const date = new Date("2026-10-30T09:12:00Z");
    expect(toDeskMail({ messageId: "<m1@example.org>", subject: "Budget", date, from: [{ name: "Ada", address: "Ada@Example.org" }] }, "example", "Text", date)).toEqual({
      kind: "mail", id: "m1@example.org", from: { name: "Ada", address: "ada@example.org" }, subject: "Budget", receivedAt: "2026-10-30T09:12:00.000Z", unread: true, firstParagraph: "Text", account: "example",
    });
    expect(toDeskMail({ messageId: "<m2@example.org>", from: [] }, "example", undefined, date)).toBeNull();
  });
});

describe("desk-ntfy", () => {
  it("posts the why as the body with the title and a view action", () => {
    const push = readPush(JSON.stringify({ key: "mail:1", title: "Ada wrote: \"Budget\"", why: "Ada is on your VIP list.", action: { label: "Open", url: "https://mail.example.org/1" } }));
    const { url, init } = ntfyRequest(push, "https://ntfy.example.org/", "my desk", "t0ken");
    expect(url).toBe("https://ntfy.example.org/my%20desk");
    expect(init.body).toBe("Ada is on your VIP list.");
    expect(init.headers).toEqual({ Title: "Ada wrote: \"Budget\"", Tags: "desk", Click: "https://mail.example.org/1", Authorization: "Bearer t0ken" });
  });

  it("refuses a push without a title and drops a non-http action", () => {
    expect(() => readPush(JSON.stringify({ key: "k", why: "w" }))).toThrow("The push needs key, title and why.");
    expect(readPush(JSON.stringify({ key: "k", title: "t", why: "w", action: { label: "Open", url: "message://x" } }))).toEqual({ key: "k", title: "t", why: "w" });
  });
});
