#!/usr/bin/env bun
/**
 * desk-calendar-create: a Desk calendar writer in front of `dist/desk-calendar-mac --create`. With `--calendar <name>`
 * it first lists the macOS calendars through `dist/desk-calendar-availability-v1` and refuses a name that no calendar
 * or more than one calendar carries, so an event never lands in a same-named calendar by guess. Without `--calendar`
 * it hands the request to the default calendar unchanged.
 * Usage: desk-calendar-create [--calendar <name>] [--writer <path>] [--reader <path>]
 */
import { join } from "node:path";
import { parseArgs } from "node:util";
import { createCalendarEvent } from "../src/calendar-create";
import { spawnRunner } from "../src/run";
import { runWriter } from "../src/writers";

const { values } = parseArgs({
  options: {
    calendar: { type: "string" },
    writer: { type: "string" },
    reader: { type: "string" },
  },
});

await runWriter((text) =>
  createCalendarEvent(text, {
    ...(values.calendar !== undefined ? { calendar: values.calendar } : {}),
    writer: values.writer ?? join(import.meta.dir, "..", "dist", "desk-calendar-mac"),
    reader: values.reader ?? join(import.meta.dir, "..", "dist", "desk-calendar-availability-v1"),
    run: spawnRunner,
  }),
);
