import type { DeskWriteResult } from "./contract";
import { isRecord } from "./guards";
import { lastLine, type Runner } from "./run";
import { readRequest, Refusal } from "./writers";

export interface CalendarCreateOptions {
  calendar?: string;
  writer: string;
  reader: string;
  run: Runner;
}

export function calendarNames(stdout: string): string[] {
  let body: unknown;
  try {
    body = JSON.parse(stdout);
  } catch {
    throw new Refusal("The calendar list could not be read, so nothing was added.");
  }
  const coverage = isRecord(body) ? body.calendarCoverage : undefined;
  const calendars = isRecord(coverage) ? coverage.calendars : undefined;
  if (!Array.isArray(calendars)) throw new Refusal("The calendar list could not be read, so nothing was added.");
  return calendars.flatMap((c) => (isRecord(c) && typeof c.name === "string" ? [c.name] : []));
}

async function checkCalendar(name: string, opts: CalendarCreateOptions): Promise<void> {
  const listed = await opts.run([opts.reader, "--days", "1"]);
  if (listed.code !== 0) throw new Refusal(`The calendars could not be listed, so nothing was added: ${lastLine(listed.stderr) || `the reader exited with code ${listed.code}.`}`);
  const count = calendarNames(listed.stdout).filter((n) => n === name).length;
  if (count === 0) throw new Refusal(`There is no calendar named ${name}, so nothing was added.`);
  if (count > 1) throw new Refusal(`${count} calendars are named ${name}, so it is unclear which one is meant and nothing was added. Rename one of them or name another calendar.`);
}

function writerAnswer(stdout: string): DeskWriteResult {
  let body: unknown;
  try {
    body = JSON.parse(stdout);
  } catch {
    throw new Refusal("The calendar writer answered in a form the Desk cannot read. The event may have been added; check before asking again.");
  }
  if (!isRecord(body) || typeof body.id !== "string" || !body.id) throw new Refusal("The calendar writer answered without an event id. The event may have been added; check before asking again.");
  return { id: body.id, ...(typeof body.message === "string" ? { message: body.message } : {}) };
}

export async function createCalendarEvent(text: string, opts: CalendarCreateOptions): Promise<DeskWriteResult> {
  readRequest(text, "calendar");
  const name = opts.calendar?.trim();
  if (opts.calendar !== undefined && !name) throw new Refusal("--calendar needs a calendar name.");
  if (name) await checkCalendar(name, opts);
  const out = await opts.run([opts.writer, "--create", ...(name ? ["--calendar", name] : [])], text);
  if (out.code !== 0) throw new Refusal(lastLine(out.stderr) || lastLine(out.stdout) || `The calendar writer exited with code ${out.code}.`);
  return writerAnswer(out.stdout);
}
