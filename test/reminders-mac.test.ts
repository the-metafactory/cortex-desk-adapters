import { expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";

const binary = join(import.meta.dir, "..", "dist", "desk-reminders-mac");
const runnable = process.platform === "darwin" && existsSync(binary);

const good = { kind: "reminder", fields: { text: "Call the dentist", due: "2026-11-02T09:00:00Z" }, requestId: "req-00000001" };

function refused(stdin: string, args: string[] = []) {
  const run = Bun.spawnSync([binary, ...args], { stdin: Buffer.from(stdin), timeout: 10_000 });
  const lines = run.stderr.toString().trim().split("\n");
  return { code: run.exitCode, stdout: run.stdout.toString(), lines };
}

const cases: [string, unknown, string][] = [
  ["a request that is not JSON", "nope", "not valid JSON"],
  ["a request of another kind", { ...good, kind: "calendar" }, "handles reminder requests, not calendar"],
  ["a request without a kind", { fields: good.fields, requestId: good.requestId }, "not none"],
  ["a request without fields", { kind: "reminder", requestId: good.requestId }, "has no fields"],
  ["a request without a request id", { kind: "reminder", fields: good.fields }, "no valid request id"],
  ["a malformed request id", { ...good, requestId: "short" }, "no valid request id"],
  ["a request id with a space", { ...good, requestId: "req 00000001" }, "no valid request id"],
  ["missing text", { ...good, fields: { due: good.fields.due } }, "text is missing"],
  ["blank text", { ...good, fields: { ...good.fields, text: "  " } }, "text is missing"],
  ["text that is not a string", { ...good, fields: { ...good.fields, text: 7 } }, "text must be text"],
  ["a missing due time", { ...good, fields: { text: good.fields.text } }, "due time is missing"],
  ["a due time that is not a date", { ...good, fields: { ...good.fields, due: "tomorrow morning" } }, "not an ISO 8601"],
  ["a due date without a time", { ...good, fields: { ...good.fields, due: "2026-11-02" } }, "not an ISO 8601"],
];

for (const [name, body, says] of cases) {
  it.skipIf(!runnable)(`desk-reminders-mac refuses ${name} in one sentence, before Reminders access`, () => {
    const r = refused(typeof body === "string" ? body : JSON.stringify(body));
    expect(r.code).toBe(2);
    expect(r.stdout).toBe("");
    expect(r.lines).toHaveLength(1);
    expect(r.lines[0]).toContain(says);
  });
}

it.skipIf(!runnable)("desk-reminders-mac checks the request before it looks for the --list", () => {
  const r = refused(JSON.stringify({ ...good, requestId: "bad" }), ["--list", "No Such List 7c1e"]);
  expect(r.code).toBe(2);
  expect(r.lines).toEqual(["The request has no valid request id, so a retry could add the reminder twice."]);
});

it.skipIf(!runnable)("desk-reminders-mac refuses an unknown argument and a --list without a name", () => {
  expect(refused("{}", ["--calendar", "Work"]).lines).toEqual(["desk-reminders-mac does not know the argument --calendar."]);
  const bare = refused("{}", ["--list"]);
  expect(bare.code).toBe(2);
  expect(bare.lines).toEqual(["--list needs the name of a Reminders list."]);
});

it.skipIf(!runnable)("desk-reminders-mac refuses to combine an access check with a writer option", () => {
  const result = refused("", ["--check-access", "--list", "Work"]);
  expect(result.code).toBe(2);
  expect(result.lines).toEqual(["desk-reminders-mac does not know the argument --check-access."]);
});

it.skipIf(process.platform !== "darwin")("a standalone access check exits with the permission result before reading a request", async () => {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const fixture = await mkdtemp(join(tmpdir(), "reminders-access-"));
  try {
    const executable = join(fixture, "desk-reminders-mac");
    const compiled = Bun.spawnSync(["swiftc", "-D", "REMINDERS_ACCESS_FIXTURE", "-o", executable,
      join(import.meta.dir, "../mac/reminders.swift")], { env: { ...process.env, CLANG_MODULE_CACHE_PATH: join(fixture, "cache") } });
    expect(compiled.exitCode).toBe(0);
    for (const [grant, code] of [["granted", 0], ["denied", 3]] as const) {
      const result = Bun.spawnSync([executable, "--check-access"], {
        env: { ...process.env, REMINDERS_TEST_GRANT: grant },
        stdin: Buffer.from("invalid writer request"),
        timeout: 10_000,
      });
      expect(result.exitCode).toBe(code);
      expect(result.stdout.toString()).toBe("");
      if (code === 3) expect(result.stderr.toString()).toContain("System Settings");
    }
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
}, 120_000);
