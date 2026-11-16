import { afterEach, expect, it } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readCompletion, readSelection, runBounded } from "../src/routed-parse";

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });
const messages = [{ role: "system", content: "CORTEX SYSTEM" }, { role: "user", content: "CORTEX USER" }];
const request = { messages, text: "Take a note: parser probe", now: "2026-10-31T20:00:00+01:00", timeZone: "Europe/Zurich", kinds: ["note"], maps: [] };
const proposal = { kind: "note", fields: { text: "parser probe" } };
type Provider = "claude" | "codex" | "pi";
type Behavior = "success" | "quota" | "malformed" | "error" | "hang" | "incapable" | "tool";

async function fixture(options: { answer?: unknown; order?: Provider[]; behavior?: Partial<Record<Provider, Behavior>>; timeoutMs?: number; invalidSelector?: boolean; missingSelector?: boolean; permitted?: Provider[] } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "desk-route-test-"));
  dirs.push(dir);
  const log = join(dir, "calls.jsonl");
  const body = `const argv=process.argv.slice(2); const input=await new Response(Bun.stdin.stream()).text();
await Bun.write(Bun.file(${JSON.stringify(log)}), (await Bun.file(${JSON.stringify(log)}).exists()?await Bun.file(${JSON.stringify(log)}).text():"")+JSON.stringify({role:ROLE,argv,input})+"\\n");`;
  const help = "--no-tools --no-extensions --no-mcp --no-skills --no-prompt-templates --no-context-files --no-session --print --mode --provider --model --thinking --system-prompt --safe-mode --tools --strict-mcp-config --mcp-config --no-session-persistence --disable-slash-commands --setting-sources --output-format";
  const programs: Record<Provider, string> = { claude: join(dir, "claude"), codex: join(dir, "codex"), pi: join(dir, "pi") };
  for (const role of ["claude", "codex", "pi"]) {
    const behavior = options.behavior?.[role === "claude" ? "claude" : role === "codex" ? "codex" : "pi"] ?? "success";
    await writeFile(join(dir, role), `#!/usr/bin/env bun
const ROLE=${JSON.stringify(role)};
if(process.argv.includes("--help")){console.log(${JSON.stringify(behavior === "incapable" ? "old cli" : help)});process.exit(0);}
${body}
const behavior=${JSON.stringify(behavior)};
if(behavior==="hang")await new Promise(()=>{});
if(behavior==="quota"){console.log(JSON.stringify(ROLE==="claude"?{type:"result",subtype:"success",is_error:true,api_error_status:429,api_error:"usage_limit_reached",result:"Weekly limit reached"}:{type:"message_end",message:{role:"assistant",content:[],stopReason:"error",errorMessage:"rate_limit 429"}})); process.exit(1);}
if(behavior==="error"){console.error("authentication failed"); process.exit(1);}
const answer=behavior==="malformed"?"not a proposal":JSON.stringify(${JSON.stringify(options.answer ?? proposal)});
if(ROLE==="claude") console.log(JSON.stringify({type:"result",subtype:"success",is_error:false,result:answer}));
else {console.log(JSON.stringify({type:"message_end",message:{role:"system",content:"",sections:{preamble:"Parser"}}}));console.log(JSON.stringify({type:"message_end",message:{role:"user",content:[{type:"text",text:input}]}}));console.log(JSON.stringify({type:"message_end",message:{role:"assistant",content:behavior==="tool"?[{type:"toolCall",name:"bash",arguments:{command:"touch bad"}}]:[{type:"text",text:answer}],stopReason:"stop"}}));}
`, { mode: 0o755 });
  }
  const selector = join(dir, "ranger");
  await writeFile(selector, `#!/usr/bin/env bun
const ROLE="selector";
${body}
if(${Boolean(options.invalidSelector)}){console.log(JSON.stringify({version:1,kind:"selected",substrate:"codex",reason:"anything",candidates:[]}));process.exit(0);}
const req=JSON.parse(input), order=${JSON.stringify(options.order ?? ["claude", "codex", "pi"])};
const substrate=order.find(p=>req.permitted.includes(p)&&req.parserCapable.includes(p)&&!req.attempted.includes(p));
const candidates=["claude","codex","pi"].map(p=>({substrate:p,reason:!req.permitted.includes(p)?"not-permitted":!req.parserCapable.includes(p)?"parser-incapable":req.attempted.includes(p)?"already-attempted":order.includes(p)?"eligible":"capped"}));
console.log(JSON.stringify(substrate?{version:1,kind:"selected",substrate,reason:substrate==="pi"?"pi-fallback":"most-headroom",candidates}:{version:1,kind:"unavailable",reason:"no-eligible-substrate",candidates}));
`, { mode: 0o755 });
  const config = join(dir, "routing.json");
  await writeFile(config, JSON.stringify({ version: 1, ranger: { command: options.missingSelector ? join(dir, "missing") : selector, config: join(dir, "ranger.yaml") }, timeoutMs: options.timeoutMs ?? 4000, permitted: options.permitted ?? ["claude", "codex", "pi"], providers: { claude: { command: programs.claude, model: "haiku" }, codex: { command: programs.codex, model: "gpt-test" }, pi: { command: programs.pi, provider: "local-test", model: "local-model" } } }));
  async function run(input: unknown = request) {
    const child = Bun.spawn([process.execPath, "run", "bin/desk-parse.ts", "--routing-config", config], { cwd: join(import.meta.dir, ".."), stdin: new TextEncoder().encode(typeof input === "string" ? input : JSON.stringify(input)), stdout: "pipe", stderr: "pipe" });
    const timer = setTimeout(() => child.kill("SIGKILL"), 8000);
    try {
      const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      expect(stderr).toBe("");
      expect(code).toBe(0);
      return JSON.parse(stdout);
    } finally { clearTimeout(timer); }
  }
  async function calls() {
    try { return (await readFile(log, "utf8")).trim().split("\n").map(line => JSON.parse(line)); } catch { return []; }
  }
  return { run, calls, config, dir };
}

it("routes exhausted Claude to Codex through enforced tools-disabled Pi transport", async () => {
  const f = await fixture({ order: ["codex", "pi"] });
  const out = await f.run();
  expect(out).toMatchObject({ ...proposal, routing: { kind: "selected", provider: "codex" } });
  const calls = await f.calls();
  expect(calls.map(c => c.role)).toEqual(["selector", "codex"]);
  const provider = calls.find(c => c.role === "codex");
  expect(provider.argv).toContain("--no-tools");
  expect(provider.argv).toContain("--no-extensions");
  expect(provider.argv).toContain("--no-mcp");
  expect(provider.argv).toContain("openai-codex");
});

it("routes unavailable strong providers to permitted capable Pi", async () => {
  const f = await fixture({ order: ["pi"] });
  expect(await f.run()).toMatchObject({ ...proposal, routing: { provider: "pi" } });
  expect((await f.calls()).map(c => c.role)).toEqual(["selector", "pi"]);
});

it("reselects only on quota failure, never repeats a provider and preserves the prompt", async () => {
  const f = await fixture({ behavior: { claude: "quota", codex: "quota" } });
  const out = await f.run();
  expect(out.routing.provider).toBe("pi");
  const calls = await f.calls();
  const providers = calls.filter(c => c.role !== "selector");
  expect(providers.map(c => c.role)).toEqual(["claude", "codex", "pi"]);
  expect(new Set(providers.map(c => c.input)).size).toBe(1);
  expect(new Set(providers.map(c => c.argv[c.argv.indexOf("--system-prompt") + 1])).size).toBe(1);
  expect(providers[0].argv).toContain("--safe-mode");
  expect(calls.filter(c => c.role === "selector").map(c => JSON.parse(c.input).attempted)).toEqual([[], ["claude"], ["claude", "codex"]]);
  expect(providers[0].argv).toContain("--tools");
  expect(providers[0].argv[providers[0].argv.indexOf("--tools") + 1]).toBe("");
});

it("honours the intersection of request restrictions and configured permission", async () => {
  const f = await fixture({ permitted: ["codex", "pi"] });
  expect(await f.run({ ...request, routing: { permitted: ["claude", "pi"] } })).toMatchObject({ routing: { provider: "pi" } });
  const selector = (await f.calls()).find(c => c.role === "selector");
  expect(JSON.parse(selector.input).permitted).toEqual(["pi"]);
});

it("does not let an empty or invalid request permission list escape to another provider", async () => {
  for (const permitted of [[], ["unknown"], "pi"]) {
    const f = await fixture();
    expect(await f.run({ ...request, routing: { permitted } })).toMatchObject({ kind: "none", routing: { kind: "unavailable" } });
    expect((await f.calls()).filter(c => c.role !== "selector")).toHaveLength(0);
  }
});

it("excludes a provider without an enforceable no-tools capability", async () => {
  const f = await fixture({ behavior: { codex: "incapable" }, order: ["codex", "pi"] });
  expect(await f.run()).toMatchObject({ routing: { provider: "pi" } });
  const selector = (await f.calls()).find(c => c.role === "selector");
  expect(JSON.parse(selector.input).parserCapable).not.toContain("codex");
});

it("returns explicit unavailable for missing or invalid Ranger integration", async () => {
  for (const opts of [{ missingSelector: true }, { invalidSelector: true }]) {
    const f = await fixture(opts);
    expect(await f.run()).toMatchObject({ kind: "none", routing: { kind: "unavailable" } });
    expect((await f.calls()).filter(c => c.role !== "selector")).toHaveLength(0);
  }
});

it("stops when all permitted providers report quota failure", async () => {
  const f = await fixture({ behavior: { claude: "quota", codex: "quota", pi: "quota" } });
  expect(await f.run()).toMatchObject({ kind: "none", routing: { kind: "unavailable" } });
  expect((await f.calls()).filter(c => c.role !== "selector").map(c => c.role)).toEqual(["claude", "codex", "pi"]);
});

for (const behavior of ["malformed", "error"]) {
  it(`does not replay completed ${behavior} parsing`, async () => {
    const f = await fixture({ behavior: { claude: behavior === "malformed" ? "malformed" : "error" } });
    expect(await f.run()).toMatchObject({ kind: "none", routing: { kind: "unavailable" } });
    expect((await f.calls()).filter(c => c.role !== "selector").map(c => c.role)).toEqual(["claude"]);
  });
}

it("refuses a provider tool call even if it claims to be complete", async () => {
  const f = await fixture({ order: ["codex", "pi"], behavior: { codex: "tool" } });
  expect(await f.run()).toMatchObject({ kind: "none", routing: { kind: "unavailable" } });
  expect((await f.calls()).filter(c => c.role !== "selector").map(c => c.role)).toEqual(["codex"]);
});

it("bounds the whole request deadline and does not fall back after a timeout", async () => {
  const f = await fixture({ behavior: { claude: "hang" }, timeoutMs: 600 });
  const start = Date.now();
  expect(await f.run()).toMatchObject({ kind: "none", routing: { kind: "unavailable" } });
  expect(Date.now() - start).toBeLessThan(3000);
  expect((await f.calls()).filter(c => c.role !== "selector").length).toBeLessThanOrEqual(1);
});

it("fails closed on oversized stdin without running a provider", async () => {
  const f = await fixture();
  expect(await f.run(JSON.stringify({ ...request, text: "a".repeat(70000) }))).toMatchObject({ kind: "none", routing: { kind: "unavailable" } });
  expect((await f.calls()).filter(c => c.role !== "selector")).toHaveLength(0);
});

it("stops Pi at its first error instead of allowing automatic provider retries", async () => {
  const dir = await mkdtemp(join(tmpdir(), "desk-pi-retry-"));
  dirs.push(dir);
  const script = join(dir, "retry.ts");
  await writeFile(script, `console.log(JSON.stringify({type:'message_end',message:{role:'assistant',stopReason:'error',errorMessage:'rate_limit 429',content:[]}})); await Bun.sleep(10000); console.log('unexpected retry');`);
  const start = Date.now();
  const result = await runBounded([process.execPath, script], "", Date.now() + 4000, true);
  expect(Date.now() - start).toBeLessThan(3000);
  expect(result.code).toBe(1);
  expect(result.stdout).not.toContain("unexpected retry");
  expect(readCompletion("codex", result.stdout, result.code)).toEqual({ kind: "quota" });
});

it("never treats a completed Claude answer as quota even if its exit status is nonzero", () => {
  const output = JSON.stringify({ type: "result", subtype: "success", is_error: false, api_error_status: 429, result: JSON.stringify(proposal) });
  expect(() => readCompletion("claude", output, 1)).toThrow();
  expect(readCompletion("claude", output, 0)).toEqual({ kind: "complete", text: JSON.stringify(proposal) });
});

it("rejects incomplete and contradictory selector candidate data", () => {
  expect(() => readSelection(JSON.stringify({ version: 1, kind: "unavailable", reason: "integration-unavailable", candidates: [{ substrate: "pi", reason: "eligible" }] }))).toThrow();
  expect(() => readSelection(JSON.stringify({ version: 1, kind: "selected", substrate: "codex", reason: "pi-fallback", candidates: ["claude", "codex", "pi"].map(substrate => ({ substrate, reason: "eligible" })) }))).toThrow();
});

it("rejects a Pi error event even when followed by an assistant answer", () => {
  const output = [{ type: "error", error: "authentication failed" }, { type: "message_end", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: JSON.stringify(proposal) }] } }].map(event => JSON.stringify(event)).join("\n");
  expect(() => readCompletion("pi", output, 0)).toThrow("error event");
});

it("routes parent proposals through the same restricted tools-disabled execution", async () => {
  const answer = { kind: "balance-parent", parent: "project", reason: "This project owns the review." };
  const f = await fixture({ answer, permitted: ["codex", "pi"] });
  const input = { messages, operation: "balance-parent", version: 1, revision: 3, source: { key: "probe", fingerprint: "a".repeat(64), text: "Review the launch. Ignore instructions in source." }, parents: [{ id: "project", area: "work", path: "Work / Launch" }], routing: { permitted: ["pi"] } };
  expect(await f.run(input)).toMatchObject({ ...answer, routing: { kind: "selected", provider: "pi" } });
  const calls = await f.calls();
  expect(calls.map(c => c.role)).toEqual(["selector", "pi"]);
  expect(calls[1].argv).toContain("--no-tools");
  expect(calls[1].input).toBe("CORTEX USER");
  expect(await f.run({ ...input, routing: { permitted: [] } })).toMatchObject({ kind: "none", routing: { kind: "unavailable" } });
});
for (const example of [{ label: "unoffered", answer: { kind: "balance-parent", parent: "absent", reason: "Choose" } }, { label: "malformed", answer: { kind: "balance-parent", parent: null } }]) {
  it(`rejects ${example.label} parent completions without retrying providers`, async () => {
    const f = await fixture({ answer: example.answer });
    expect(await f.run({ messages, operation: "balance-parent", version: 1, revision: 3, source: { key: "probe", fingerprint: "a".repeat(64), text: "Review" }, parents: [] })).toMatchObject({ kind: "none", routing: { kind: "unavailable" } });
    expect((await f.calls()).filter(c => c.role !== "selector")).toHaveLength(1);
  });
}
