import { afterEach, expect, it } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true }))); });

const messages = [{ role: "system", content: "Cortex system prompt" }, { role: "user", content: "Cortex user prompt\nwith two lines" }];
const request = { text: "note this", now: "2026-10-31T20:00:00+01:00", timeZone: "Europe/Zurich", kinds: ["note"], maps: [], messages };
const answer = JSON.stringify({ kind: "note", fields: { text: "note this" } });
const help = "--no-tools --no-extensions --no-mcp --no-skills --no-prompt-templates --no-context-files --no-session --print --mode --provider --model --thinking --system-prompt --safe-mode --tools --strict-mcp-config --mcp-config --no-session-persistence --disable-slash-commands --setting-sources --output-format";

async function stub() {
  const dir = await mkdtemp(join(tmpdir(), "desk-parse-messages-"));
  dirs.push(dir);
  const log = join(dir, "calls.jsonl");
  const claude = join(dir, "claude");
  await writeFile(claude, `#!/usr/bin/env bun
if (process.argv.includes("--help")) { console.log(${JSON.stringify(help)}); process.exit(0); }
const input = await new Response(Bun.stdin.stream()).text();
const fs = require("node:fs");
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ argv: process.argv.slice(2), input }) + "\\n");
console.log(process.argv.includes("json") ? JSON.stringify({ type: "result", subtype: "success", is_error: false, result: ${JSON.stringify(answer)} }) : ${JSON.stringify(answer)});
`, { mode: 0o755 });
  const ranger = join(dir, "ranger");
  await writeFile(ranger, `#!/usr/bin/env bun
console.log(JSON.stringify({ version: 1, kind: "selected", substrate: "claude", reason: "most-headroom", candidates: [{ substrate: "claude", reason: "eligible" }, { substrate: "codex", reason: "not-configured" }, { substrate: "pi", reason: "not-configured" }] }));
`, { mode: 0o755 });
  const config = join(dir, "routing.json");
  await writeFile(config, JSON.stringify({ version: 1, ranger: { command: ranger, config: join(dir, "r.yaml") }, timeoutMs: 4000, permitted: ["claude"], providers: { claude: { command: claude, model: "haiku" } } }));
  const calls = async () => { try { return (await readFile(log, "utf8")).trim().split("\n").map((l) => JSON.parse(l)); } catch { return []; } };
  return { claude, config, calls };
}

async function run(args: string[], input: unknown) {
  const child = Bun.spawn([process.execPath, "run", "bin/desk-parse.ts", ...args], { cwd: join(import.meta.dir, ".."), stdin: new TextEncoder().encode(JSON.stringify(input)), stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { stdout, stderr, code };
}

it("sends the system message as the system prompt and the user message as stdin, with the default claude provider", async () => {
  const f = await stub();
  const out = await run(["--claude", f.claude], request);
  expect(out.code).toBe(0);
  expect(JSON.parse(out.stdout)).toEqual({ kind: "note", fields: { text: "note this" } });
  const [call] = await f.calls();
  expect(call.argv[call.argv.indexOf("--system-prompt") + 1]).toBe("Cortex system prompt");
  expect(call.input).toBe("Cortex user prompt\nwith two lines");
  expect(call.argv[call.argv.indexOf("--tools") + 1]).toBe("");
});

it("sends the same messages to a routing-config provider", async () => {
  const f = await stub();
  const out = await run(["--routing-config", f.config], request);
  expect(JSON.parse(out.stdout)).toMatchObject({ kind: "note", routing: { kind: "selected", provider: "claude" } });
  const calls = (await f.calls()).filter((c) => !c.argv.includes("--help"));
  expect(calls).toHaveLength(1);
  expect(calls[0].argv[calls[0].argv.indexOf("--system-prompt") + 1]).toBe("Cortex system prompt");
  expect(calls[0].input).toBe("Cortex user prompt\nwith two lines");
});

it("exits non-zero with one line naming messages, and calls no provider, when the request has none", async () => {
  const f = await stub();
  const { messages: _omit, ...bare } = request;
  const out = await run(["--claude", f.claude], bare);
  expect(out.code).not.toBe(0);
  expect(out.stderr.trim().split("\n")).toHaveLength(1);
  expect(out.stderr).toContain("messages");
  expect(await f.calls()).toHaveLength(0);
  const routed = await run(["--routing-config", f.config], bare);
  expect(routed.stdout).toContain("messages");
  expect((await f.calls())).toHaveLength(0);
});
