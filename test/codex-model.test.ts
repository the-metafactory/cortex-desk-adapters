import { describe, expect, it } from "bun:test";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { codexArgs, codexEnvironment, runCodexJson as nativeRun } from "../src/codex-json";
import { CodexChatModel } from "../src/codex-chat-model";
import { personalFlow, readPersonalScope } from "../src/personal-scope";
import { classifyMail } from "../src/classify-mail";
import { readTriageRequest } from "../src/triage";

const runCodexJson: typeof nativeRun = (prompt, options) => nativeRun(prompt, options, async argv => argv);
const ROOT = join(import.meta.dir, "..");
const FLOW = join(ROOT, "flows", "desk-mail-triage.yaml");
const request = () => readTriageRequest(JSON.stringify({ sourcePolicy: "cloud", mail: { id: "personal-1", account: "personal", sourceId: "personal-mail", from: { address: "ada@example.org" }, subject: "Garden gathering", receivedAt: "2026-11-06T09:00:00Z" }, meetings: [{ key: "cal:personal:1", sourceId: "personal-calendar", sourcePolicy: "cloud", title: "Garden gathering", start: "2026-11-07T12:00:00Z" }], notes: [{ id: "studio:personal", areas: ["personal"], sourcePolicy: "cloud", name: "Garden", text: "Bring seeds" }] }));

describe("native Codex boundary", () => {
  it("disables independent context/tools and inherits only native auth environment", () => {
    const args = codexArgs({ model: "gpt-6.1-sol", timeoutMs: 1000 }, "/private/empty", "/private/empty/answer");
    for (const flag of ["--ignore-user-config", "--ephemeral", "read-only", "project_doc_max_bytes=0", "web_search=disabled", "shell_tool", "hooks", "apps", "plugins", "memories"]) expect(args).toContain(flag);
    expect(codexEnvironment({ HOME: "/native", CODEX_HOME: "/native/auth", OPENAI_API_KEY: "secret", COMPANY_DATA: "private" })).toEqual({ HOME: "/native", CODEX_HOME: "/native/auth" });
  });

  it("extracts only validated final JSON and rejects independent tool events", async () => {
    const dir = await mkdtemp(join(tmpdir(), "codex-fixture-"));
    const exe = join(dir, "fake.ts");
    const script = (type: string) => `#!/usr/bin/env bun\nconst a=process.argv;await Bun.write(a[a.indexOf("--output-last-message")+1],JSON.stringify({ok:true}));console.log(JSON.stringify({type:"item.completed",item:{type:"${type}"}}));console.log(JSON.stringify({type:"turn.completed",usage:{input_tokens:1,output_tokens:2}}));`;
    try {
      await Bun.write(exe, script("agent_message")); await chmod(exe, 0o700);
      expect(await runCodexJson("synthetic", { codex: exe, model: "test", timeoutMs: 1000 })).toMatchObject({ answer: { ok: true }, usage: { input: 1, output: 2 } });
      await Bun.write(exe, script("command_execution"));
      await expect(runCodexJson("synthetic", { codex: exe, model: "test", timeoutMs: 1000 })).rejects.toThrow("independent tool");
      const pidFile = join(dir, "child.pid");
      await Bun.write(exe, `#!/usr/bin/env bun\nconst child=Bun.spawn([process.execPath,"-e","await Bun.sleep(30000)"],{stdout:"inherit",stderr:"inherit"});await Bun.write(${JSON.stringify(pidFile)},String(child.pid));await Bun.sleep(30000);`);
      await expect(runCodexJson("synthetic", { codex: exe, model: "test", timeoutMs: 1000 })).rejects.toThrow("timed out");
      const pid = Number(await Bun.file(pidFile).text()); await Bun.sleep(100);
      expect(() => process.kill(pid, 0)).toThrow();
      await Bun.write(exe, "#!/usr/bin/env bun\nawait Bun.sleep(10000);");
      const abort = new AbortController();
      const running = runCodexJson("synthetic", { codex: exe, model: "test", timeoutMs: 10000, signal: abort.signal });
      setTimeout(() => abort.abort(), 50);
      await expect(running).rejects.toThrow("aborted");
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it("enforces the native deadline after the owning wrapper is killed", async () => {
    const dir = await mkdtemp(join(tmpdir(), "codex-owner-"));
    const exe = join(dir, "fake.ts");
    const pidFile = join(dir, "native.pid");
    const ownerFile = join(dir, "owner.ts");
    let owner: Bun.Subprocess | undefined;
    let nativePid = 0;
    try {
      await Bun.write(exe, `#!/usr/bin/env bun\nawait Bun.write(${JSON.stringify(pidFile)},String(process.pid));await Bun.sleep(30000);`); await chmod(exe, 0o700);
      await Bun.write(ownerFile, `import {runCodexJson} from ${JSON.stringify(join(ROOT, "src/codex-json.ts"))};await runCodexJson("synthetic",{codex:${JSON.stringify(exe)},model:"test",timeoutMs:2000},async argv=>argv);`);
      owner = Bun.spawn([process.execPath, ownerFile], { stdout: "ignore", stderr: "ignore" });
      for (let n = 0; n < 100 && !await Bun.file(pidFile).exists(); n++) await Bun.sleep(20);
      nativePid = Number(await Bun.file(pidFile).text());
      owner.kill("SIGKILL"); await owner.exited;
      let alive = true;
      for (let n = 0; n < 30 && alive; n++) { await Bun.sleep(100); try { process.kill(nativePid, 0); } catch { alive = false; } }
      expect(alive).toBe(false);
    } finally { if (owner?.exitCode === null) owner.kill("SIGKILL"); if (nativePid > 1) { try { process.kill(nativePid, "SIGKILL"); } catch {} } await rm(dir, { recursive: true, force: true }); }
  }, 7000);

  it("rejects undeclared tools before Pulse can execute them", async () => {
    const model = new CodexChatModel({ model: "test", timeoutMs: 1000 }, async () => ({ answer: { content: null, toolCalls: [{ id: "1", type: "function", function: { name: "WRITE_MAIL", arguments: "{}" } }] }, itemTypes: [] }));
    await expect(model.complete({ messages: [{ role: "user", content: "x" }], tools: [] })).rejects.toThrow("undeclared");
  });
});

describe("personal research scope", () => {
  it("fails closed for unknown/local sources and unlisted accounts", async () => {
    for (const req of [{ ...request(), sourcePolicy: undefined }, { ...request(), sourcePolicy: "local" as const }, { ...request(), mail: { ...request().mail, account: "work" } }]) await expect(personalFlow(req, FLOW, ["personal"], 1000, ["personal-mail", "personal-calendar"], ["personal"])).rejects.toThrow("cloud-approved");
  });

  it("rejects forged calendar and note provenance before creating the flow", async () => {
    const base = request();
    await expect(personalFlow({ ...base, meetings: [{ ...base.meetings[0]!, sourceId: "work-calendar" }] }, FLOW, ["personal"], 1000, ["personal-mail", "personal-calendar"], ["personal"])).rejects.toThrow("Calendar source");
    await expect(personalFlow({ ...base, notes: [{ id: "work-note", name: "Work", text: "synthetic", sourcePolicy: "cloud", areas: ["work"] }] }, FLOW, ["personal"], 1000, ["personal-mail", "personal-calendar"], ["personal"])).rejects.toThrow("Note areas");
  });

  it("searches only the provided cloud snapshot and states its coverage", async () => {
    const read = async () => JSON.stringify({ policy: "cloud", meetings: request().meetings, notes: request().notes });
    expect(await readPersonalScope({ scopeFile: "bound", query: "garden" }, read, "calendar")).toMatchObject({ events: [{ title: "Garden gathering" }], coverage: expect.stringContaining("Other calendars") });
    expect(await readPersonalScope({ scopeFile: "bound", query: "seeds" }, read, "notes")).toMatchObject({ notes: [{ id: "studio:personal" }] });
    expect(await readPersonalScope({ scopeFile: "bound", query: "start" }, read, "calendar")).toMatchObject({ events: [] });
    await expect(readPersonalScope({ scopeFile: "bound" }, async () => '{"policy":"local"}', "notes")).rejects.toThrow();
  });

  it("keeps mail research bound to the personal account even when the model tries work", async () => {
    const scoped = await personalFlow(request(), FLOW, ["personal"], 5000, ["personal-mail", "personal-calendar"], ["personal"]);
    const dir = await mkdtemp(join(tmpdir(), "codex-mail-bound-"));
    const action = join(dir, "A_MAIL_SEARCH");
    await Bun.write(join(action, "action.json"), JSON.stringify({ name: "A_MAIL_SEARCH", version: "1.0.0", description: "Synthetic account boundary fixture", effect: "read", input: { account: { type: "string", required: true }, query: { type: "string" } }, output: { accountUsed: { type: "string" } } }));
    await Bun.write(join(action, "action.ts"), 'export default { execute(input: {account:string}) { return Promise.resolve({accountUsed: input.account}); } };');
    const prompts: string[] = [];
    const backend = new CodexChatModel({ model: "test", timeoutMs: 1000 }, async prompt => {
      prompts.push(prompt);
      const n = prompts.length;
      return { itemTypes: [], answer: n < 3 ? { content: null, toolCalls: [{ id: `mail-${n}`, type: "function", function: { name: "A_MAIL_SEARCH", arguments: JSON.stringify(n === 1 ? { account: "work", query: "synthetic" } : { query: "synthetic" }) } }] } : { content: JSON.stringify({ category: "fyi", reason: "Synthetic personal research completed." }), toolCalls: [] } };
    });
    try {
      await classifyMail(request(), { flow: scoped.flow, model: backend, actionDirs: [...scoped.actionDirs, dir, join(ROOT, "test", "fixtures", "actions")], transcriptDir: join(dir, "transcripts") });
      const exchange = JSON.parse(prompts[2]!.split("\n").slice(1).join("\n")) as { messages: { role: string; content: string }[] };
      expect(exchange.messages.filter(item => item.role === "tool").map(item => item.content)).toEqual(["personal", "personal"]);
      expect(prompts[2]).toContain('personal');
      expect(prompts[2]).not.toContain('accountUsed\\\":\\\"work');
    } finally { await scoped.close(); await rm(dir, { recursive: true, force: true }); }
  });

  it("preserves two Pulse research rounds with bound scoped tools and their actual results", async () => {
    const scoped = await personalFlow(request(), FLOW, ["personal"], 5000, ["personal-mail", "personal-calendar"], ["personal"]);
    const transcripts = await mkdtemp(join(tmpdir(), "codex-rounds-"));
    const prompts: string[] = [];
    const model = new CodexChatModel({ model: "test", timeoutMs: 1000 }, async prompt => {
      prompts.push(prompt);
      const names = ["A_CALENDAR_EVENTS", "A_NOTES_SEARCH"];
      const name = names[prompts.length - 1];
      return { itemTypes: ["agent_message"], answer: name ? { content: null, toolCalls: [{ id: `round-${prompts.length}`, type: "function", function: { name, arguments: JSON.stringify({ query: prompts.length === 1 ? "garden" : "seeds" }) } }] } : { content: JSON.stringify({ category: "meeting", commitment: "invitation", meetingKey: "cal:personal:1", reason: "The invitation concerns the garden gathering.", evidence: [{ kind: "note", ref: "studio:personal", title: "Garden" }] }), toolCalls: [] } };
    });
    try {
      const result = await classifyMail(request(), { flow: scoped.flow, model, actionDirs: [...scoped.actionDirs, join(ROOT, "test", "fixtures", "actions")], transcriptDir: transcripts });
      expect(result).toMatchObject({ rounds: 2, toolCalls: 2, answer: { category: "meeting" } });
      expect(prompts[0]).not.toContain("scopeFile");
      const second = JSON.parse(prompts[1]!.split("\n").slice(1).join("\n")) as { messages: { role: string; tool_calls?: { id: string; function: { name: string } }[] }[] };
      expect(second.messages.find(item => item.role === "assistant")?.tool_calls?.[0]).toMatchObject({ id: "round-1", function: { name: "A_CALENDAR_EVENTS" } });
      expect(prompts[2]).toContain("Bring seeds");
      expect(prompts[2]).toContain("Other calendars");
    } finally { await scoped.close(); await rm(transcripts, { recursive: true, force: true }); }
  });
});
