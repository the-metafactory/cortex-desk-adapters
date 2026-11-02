#!/usr/bin/env bun
/**
 * desk-calendar: the next days of one calendar as Desk events.
 * Usage: desk-calendar --exchange [--days 5]
 *        desk-calendar --mac [--exclude Calendar] [--days 5]
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { dedupe, fromExchange, fromMac, type ExchangeEvent, type MacEvent } from "../src/calendar";
import type { DeskSourceOutput } from "../src/contract";
import { fromRawExchange } from "../src/calendar-availability";

const { values } = parseArgs({
  options: {
    exchange: { type: "boolean", default: false },
    availability: { type: "boolean", default: false },
    mac: { type: "boolean", default: false },
    exclude: { type: "string", multiple: true, default: [] },
    days: { type: "string", default: "5" },
    ical: { type: "string", default: join(homedir(), ".soma/skills/Calendar/ical") },
  },
});

async function ical(args: string[]): Promise<string> {
  const proc = Bun.spawn([values.ical ?? "ical", ...args], { stdout: "pipe", stderr: "pipe" });
  const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  if (code !== 0) throw new Error(`ical ${args.join(" ")} exited ${code}`);
  return out;
}

const days = values.days ?? "5";
let output: DeskSourceOutput;
if (values.exchange) {
  if (values.availability) {
    output = fromRawExchange(JSON.parse(await ical(["exchange", "availability-raw", "--next", days])));
  } else {
  const body = JSON.parse(await ical(["exchange", "list", "--next", days, "--compact", "--format", "json"])) as { events: ExchangeEvent[] };
  output = { capabilities: ["calendar"], events: dedupe(body.events.map(fromExchange)) };
  }
} else if (values.mac) {
  const excluded = new Set(values.exclude ?? []);
  const events = (JSON.parse(await ical(["read", "--next", days, "--format", "json"])) as MacEvent[]).filter((e) => !excluded.has(e.calendar));
  output = { capabilities: ["calendar"], events: dedupe(events.map(fromMac)) };
} else {
  process.stderr.write("desk-calendar: pass --exchange or --mac\n");
  process.exit(2);
}
process.stdout.write(JSON.stringify(output));
