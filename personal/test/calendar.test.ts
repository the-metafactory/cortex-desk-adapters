import { expect, it } from "bun:test";
import { eventPeople, MAX_EVENT_ATTENDEES } from "../../src/attendees";
import { dedupe, fromExchange, fromMac, localIso, type MacEvent } from "../src/calendar";

it("sends an Exchange meeting's organizer and attendee addresses in lowercase, and drops names and legacy DNs", () => {
  const e = fromExchange({
    date: "2026-11-16", startTime: "10:00", endTime: "11:00", title: "Venue walkthrough",
    organizer: "Grace@Example.org",
    attendees: [{ email: "Ada@Example.org" }, { email: "Bob Smith" }, { email: "/o=ExchangeLabs/ou=Exchange Administrative Group/cn=Recipients/cn=bob" }, { email: "ada@example.org" }, { email: null }],
  });
  expect(e.organizer).toEqual({ address: "grace@example.org" });
  expect(e.attendees).toEqual([{ address: "ada@example.org" }]);
});

it("leaves out organizer and attendees when Exchange gives no address, rather than sending an empty list", () => {
  const none = fromExchange({ date: "2026-11-16", startTime: "10:00", title: "Focus", organizer: null, attendees: [] });
  expect("organizer" in none || "attendees" in none).toBe(false);
  const namesOnly = fromExchange({ date: "2026-11-16", startTime: "10:00", title: "Call", organizer: "Grace Hopper", attendees: [{ email: "Bob Smith" }] });
  expect("organizer" in namesOnly || "attendees" in namesOnly).toBe(false);
  expect(fromExchange({ date: "2026-11-16", startTime: "10:00", title: "Older ical" })).not.toHaveProperty("attendees");
});

it("sends an organizer without attendees, and attendees without an organizer", () => {
  const organizerOnly = fromExchange({ date: "2026-11-16", startTime: "10:00", title: "A", organizer: "grace@example.org", attendees: [] });
  expect(organizerOnly).toMatchObject({ organizer: { address: "grace@example.org" } });
  expect(organizerOnly).not.toHaveProperty("attendees");
  expect(fromExchange({ date: "2026-11-16", startTime: "10:00", title: "B", organizer: null, attendees: [{ email: "bob@example.org" }] })).toMatchObject({ attendees: [{ address: "bob@example.org" }] });
});

it("sends no people for a macOS event, whose source gives attendee names only", () => {
  const e = fromMac({ title: "Choir", calendar: "Personal", date: "2026-11-02", start_at: "20:00", attendees: ["Alice", "Bob"] } as MacEvent);
  expect("organizer" in e || "attendees" in e).toBe(false);
});

it("keeps at most as many attendees as Cortex reads", () => {
  const many = Array.from({ length: MAX_EVENT_ATTENDEES + 20 }, (_, i) => `p${i}@example.org`);
  expect(eventPeople(null, many).attendees).toHaveLength(MAX_EVENT_ATTENDEES);
});

it("maps an Exchange meeting with a Teams link", () => {
  const e = fromExchange({ date: "2026-10-30", startTime: "13:00", endTime: "14:00", title: "DA results", location: "Microsoft Teams Meeting", meetingLink: "https://teams.example/j/1" });
  expect(e).toEqual({ id: "2026-10-30|13:00|DA results", start: localIso("2026-10-30", "13:00"), end: localIso("2026-10-30", "14:00"), title: "DA results", calendar: "Exchange", location: "Microsoft Teams Meeting", online: true, url: "https://teams.example/j/1" });
});

it("treats an Exchange event without a start time as all-day", () => {
  expect(fromExchange({ date: "2026-11-05", isAllDay: true, title: "CotD" })).toMatchObject({ allDay: true, start: localIso("2026-11-05") });
});

it("maps a macOS event and keeps only web links", () => {
  expect(fromMac({ title: "Choir", calendar: "Personal", date: "2026-11-02", start_at: "20:00", end_at: "22:30", urls: ["x-apple:1", "https://choir.example"] }))
    .toEqual({ id: "Personal|2026-11-02|20:00|Choir", start: localIso("2026-11-02", "20:00"), end: localIso("2026-11-02", "22:30"), title: "Choir", calendar: "Personal", url: "https://choir.example" });
  expect(fromMac({ title: "Guest stay", calendar: "Holiday flat", date: "2026-10-30" })).toMatchObject({ allDay: true });
});

it("collapses an event repeated in the list and sorts by start", () => {
  const a = fromMac({ title: "Guest stay", calendar: "Holiday flat", date: "2026-10-31" });
  const b = fromMac({ title: "Choir", calendar: "Personal", date: "2026-10-30", start_at: "20:00" });
  expect(dedupe([a, b, a]).map((e) => e.title)).toEqual(["Choir", "Guest stay"]);
});
