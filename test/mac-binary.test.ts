import { expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { DeskSourceEvent } from "../src/cortex-contract";

const binary = join(import.meta.dir, "..", "dist", "desk-calendar-mac");
const runnable = process.platform === "darwin" && existsSync(binary);

it.skipIf(!runnable)("desk-calendar-mac prints events in the Desk contract shape", () => {
  const run = Bun.spawnSync([binary, "--days", "1"]);
  expect(run.exitCode).toBe(0);
  const { events } = JSON.parse(run.stdout.toString()) as { events: DeskSourceEvent[] };
  for (const e of events) {
    expect(typeof e.id).toBe("string");
    expect(Number.isFinite(Date.parse(e.start))).toBe(true);
    expect(typeof e.title).toBe("string");
    if (e.end !== undefined) expect(Number.isFinite(Date.parse(e.end))).toBe(true);
    if (e.url !== undefined) expect(e.url).toMatch(/^https?:/);
    if (e.allDay) expect(e.start).not.toMatch(/Z$/);
  }
});

it.skipIf(!runnable)("desk-calendar-mac fails, naming the calendars it knows, when --include matches nothing", () => {
  const run = Bun.spawnSync([binary, "--include", "No Such Calendar 7c1e"]);
  expect(run.exitCode).toBe(4);
  expect(run.stderr.toString()).toContain("no calendar named No Such Calendar 7c1e");
});
