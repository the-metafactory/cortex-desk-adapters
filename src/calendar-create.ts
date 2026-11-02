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

const UNREADABLE_LIST = "The calendar list could not be read, so nothing was added.";
const MAYBE_ADDED = "The event may have been added; check before asking again.";

function parseOrRefuse(stdout: string, refusal: string): unknown {
  try {
    return JSON.parse(stdout);
  } catch {
    throw new Refusal(refusal);
  }
}

export function calendarNames(stdout: string): string[] {
  const body = parseOrRefuse(stdout, UNREADABLE_LIST);
  const coverage = isRecord(body) ? body.calendarCoverage : undefined;
  const calendars = isRecord(coverage) ? coverage.calendars : undefined;
  if (!Array.isArray(calendars)) throw new Refusal(UNREADABLE_LIST);
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
  const body = parseOrRefuse(stdout, `The calendar writer answered in a form the Desk cannot read. ${MAYBE_ADDED}`);
  if (!isRecord(body) || typeof body.id !== "string" || !body.id) throw new Refusal(`The calendar writer answered without an event id. ${MAYBE_ADDED}`);
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
