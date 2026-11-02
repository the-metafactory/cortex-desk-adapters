import { expect, it } from "bun:test";
import { calendarNames, createCalendarEvent } from "../src/calendar-create";
import type { Runner } from "../src/run";

const REQUEST = JSON.stringify({ kind: "calendar", fields: { title: "Probe", start: "2026-11-07T07:00:00Z" }, requestId: "req-00000001" });
const listing = (...names: string[]) => JSON.stringify({ capabilities: ["calendar"], events: [], calendarCoverage: { calendars: names.map((name, i) => ({ id: `c${i}`, name })) } });

function fake(names: string[], writer = { code: 0, stdout: JSON.stringify({ id: "ev1", message: "Added." }), stderr: "" }, reader?: { code: number; stdout: string; stderr: string }) {
  const calls: { argv: string[]; stdin?: string }[] = [];
  const run: Runner = async (argv, stdin) => {
    calls.push({ argv, ...(stdin !== undefined ? { stdin } : {}) });
    if (argv[0] === "reader") return reader ?? { code: 0, stdout: listing(...names), stderr: "" };
    return writer;
  };
  return { run, calls, opts: (calendar?: string) => ({ ...(calendar !== undefined ? { calendar } : {}), writer: "writer", reader: "reader", run }) };
}

it("refuses a calendar name that more than one calendar carries and writes nothing", async () => {
  const f = fake(["Calendar", "Privat", "Calendar", "Kalender"]);
  await expect(createCalendarEvent(REQUEST, f.opts("Calendar"))).rejects.toThrow("2 calendars are named Calendar");
  expect(f.calls.map((c) => c.argv[0])).toEqual(["reader"]);
});

it("refuses a calendar name no calendar carries", async () => {
  const f = fake(["Calendar", "Privat"]);
  await expect(createCalendarEvent(REQUEST, f.opts("Private"))).rejects.toThrow("There is no calendar named Private");
  expect(f.calls.map((c) => c.argv[0])).toEqual(["reader"]);
});

it("writes to a calendar name exactly one calendar carries, passing the request on unchanged", async () => {
  const f = fake(["Calendar", "Privat", "Calendar"]);
  expect(await createCalendarEvent(REQUEST, f.opts("Privat"))).toEqual({ id: "ev1", message: "Added." });
  expect(f.calls).toEqual([{ argv: ["reader", "--days", "1"] }, { argv: ["writer", "--create", "--calendar", "Privat"], stdin: REQUEST }]);
});

it("without a calendar name writes to the default calendar without listing calendars", async () => {
  const f = fake([]);
  await createCalendarEvent(REQUEST, f.opts());
  expect(f.calls).toEqual([{ argv: ["writer", "--create"], stdin: REQUEST }]);
});

it("refuses when the calendars cannot be listed, and refuses a bad request before reading calendars", async () => {
  const f = fake([], undefined, { code: 3, stdout: "", stderr: "Calendar access is not granted to this separate reader." });
  await expect(createCalendarEvent(REQUEST, f.opts("Privat"))).rejects.toThrow("could not be listed");
  const g = fake(["Privat"]);
  await expect(createCalendarEvent('{"kind":"task","fields":{}}', g.opts("Privat"))).rejects.toThrow("calendar requests");
  await expect(createCalendarEvent(REQUEST, g.opts(" "))).rejects.toThrow("needs a calendar name");
  expect(g.calls).toHaveLength(0);
});

it("passes the writer's refusal on, and reads only well-formed calendar lists", async () => {
  const f = fake(["Privat"], { code: 4, stdout: "", stderr: "There is no calendar named Privat that takes new events; these do: Calendar." });
  await expect(createCalendarEvent(REQUEST, f.opts("Privat"))).rejects.toThrow("that takes new events");
  expect(() => calendarNames("{}")).toThrow("could not be read");
  expect(calendarNames(listing("A", "B"))).toEqual(["A", "B"]);
});
