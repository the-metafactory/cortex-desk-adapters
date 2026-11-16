import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { z } from "zod";

const DISABLED = ["shell_tool", "apps", "plugins", "hooks", "browser_use", "browser_use_external", "browser_use_full_cdp_access", "computer_use", "multi_agent", "image_generation", "in_app_browser", "skill_search", "view_image", "workspace_dependencies", "tool_suggest", "sleep_tool", "memories"];
const EventSchema = z.object({ type: z.string(), item: z.object({ type: z.string(), message: z.string().optional() }).passthrough().optional(), usage: z.object({ input_tokens: z.number(), output_tokens: z.number() }).passthrough().optional() }).passthrough();
const ENV_KEYS = ["HOME", "USER", "LOGNAME", "PATH", "CODEX_HOME", "TMPDIR", "LANG", "LC_ALL", "SHELL", "SSL_CERT_FILE", "NODE_EXTRA_CA_CERTS"];

export interface CodexJsonOptions {
  codex?: string;
  model: string;
  timeoutMs: number;
  signal?: AbortSignal;
  schema?: string;
}

export interface CodexJsonResult {
  answer: unknown;
  usage?: { input: number; output: number };
  itemTypes: string[];
}

export function codexArgs(options: CodexJsonOptions, cwd: string, output: string): string[] {
  return [options.codex ?? "codex", "exec", "--ignore-user-config", "--ephemeral", "--skip-git-repo-check", "--sandbox", "read-only", "--model", options.model, "--json", "--color", "never", "--cd", cwd, "--output-last-message", output,
    ...DISABLED.flatMap(name => ["--disable", name]), "-c", "web_search=disabled", "-c", "project_doc_max_bytes=0", "-c", "skills.include_instructions=false", "-c", "shell_environment_policy.inherit=none", ...(options.schema ? ["--output-schema", options.schema] : []), "-"];
}

export function codexEnvironment(env: Record<string, string | undefined> = process.env): Record<string, string | undefined> {
  return Object.fromEntries(ENV_KEYS.flatMap(key => env[key] === undefined ? [] : [[key, env[key]]]));
}

export async function instructionIsolation(argv: string[], codexHome: string): Promise<string[]> {
  const paths = await Promise.all(["AGENTS.md", "AGENTS.override.md"].map(async name => { const path = join(codexHome, name); return { path, actual: await realpath(path).catch(() => path) }; }));
  if (process.platform !== "darwin") {
    for (const { path } of paths) {
      const content = await readFile(path, "utf8").catch((error: unknown) => { if (error instanceof Error && "code" in error && error.code === "ENOENT") return ""; throw error; });
      if (content.trim()) throw new Error("Native Codex global instructions cannot be isolated on this platform");
    }
    return argv;
  }
  const denied = [...new Set(paths.flatMap(item => [item.path, item.actual]))];
  const profile = `(version 1)(allow default)(deny file-read* ${denied.map(path => `(literal ${JSON.stringify(path)})`).join(" ")})`;
  return ["/usr/bin/sandbox-exec", "-p", profile, ...argv];
}

async function boundedText(stream: ReadableStream<Uint8Array>, limit: number, stop: () => void): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let result = "";
  let bytes = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) return result + decoder.decode();
      bytes += next.value.byteLength;
      if (bytes > limit) { stop(); throw new Error("Codex output exceeded the limit"); }
      result += decoder.decode(next.value, { stream: true });
    }
  } finally { reader.releaseLock(); }
}

export async function runCodexJson(prompt: string, options: CodexJsonOptions, isolate: typeof instructionIsolation = instructionIsolation): Promise<CodexJsonResult> {
  if (options.signal?.aborted) throw new Error("Codex request aborted");
  const cwd = await mkdtemp(join(tmpdir(), "desk-codex-"));
  const output = join(cwd, "answer.json");
  let timer: ReturnType<typeof setTimeout> | undefined;
  let aborted = false;
  let cleanup: (() => Promise<void>) | undefined;
  let watchdog: Bun.Subprocess | undefined;
  try {
    const argv = await isolate(codexArgs(options, cwd, output), process.env.CODEX_HOME ?? join(process.env.HOME ?? homedir(), ".codex"));
    const proc = Bun.spawn(argv, { cwd, detached: process.platform !== "win32", env: { ...codexEnvironment(), HOME: process.env.HOME ?? homedir() }, stdin: new Blob([prompt]), stdout: "pipe", stderr: "pipe" });
    const stop = () => { aborted = true; try { if (process.platform !== "win32") process.kill(-proc.pid, "SIGKILL"); else if (proc.exitCode === null) proc.kill("SIGKILL"); } catch { if (proc.exitCode === null) proc.kill("SIGKILL"); } };
    cleanup = async () => { stop(); await proc.exited; options.signal?.removeEventListener("abort", stop); };
    watchdog = Bun.spawn([process.execPath, fileURLToPath(new URL("./codex-watchdog.ts", import.meta.url)), String(process.pid), String(proc.pid), String(options.timeoutMs)], { detached: process.platform !== "win32", stdin: "ignore", stdout: "ignore", stderr: "ignore", env: codexEnvironment() });
    timer = setTimeout(stop, options.timeoutMs);
    options.signal?.addEventListener("abort", stop, { once: true });
    if (options.signal?.aborted) stop();
    let stdout: string;
    let code: number;
    try {
      [stdout, , code] = await Promise.all([boundedText(proc.stdout, 2_000_000, stop), boundedText(proc.stderr, 2_000_000, stop), proc.exited]);
    } finally { options.signal?.removeEventListener("abort", stop); }
    if (aborted) throw options.signal?.aborted && options.signal.reason instanceof Error ? options.signal.reason : new Error("Codex request timed out or was aborted");
    if (code !== 0) throw new Error(`Codex command exited ${code}`);
    const events = stdout.split("\n").filter(line => line.trim() !== "").map(line => EventSchema.parse(JSON.parse(line)));
    const globalHome = process.env.CODEX_HOME ?? join(process.env.HOME ?? homedir(), ".codex");
    const warnings = new Set(["AGENTS.md", "AGENTS.override.md"].map(name => `Failed to read global AGENTS.md instructions from \`${join(globalHome, name)}\`: Operation not permitted (os error 1)`));
    const itemTypes = events.flatMap(event => event.item && !(event.item.type === "error" && warnings.has(event.item.message ?? "")) ? [event.item.type] : []);
    if (itemTypes.some(type => type !== "agent_message" && type !== "reasoning")) throw new Error(`Codex attempted an independent tool: ${[...new Set(itemTypes)].join(",")}`);
    if (events.some(event => event.type === "error" || event.type === "turn.failed")) throw new Error("Codex turn failed");
    if (!events.some(event => event.type === "turn.completed") || !itemTypes.includes("agent_message")) throw new Error("Codex returned no completed answer");
    const answer: unknown = JSON.parse(await readFile(output, "utf8"));
    const usage = events.filter(event => event.type === "turn.completed").at(-1)?.usage;
    return { answer, itemTypes, ...(usage ? { usage: { input: usage.input_tokens, output: usage.output_tokens } } : {}) };
  } finally {
    clearTimeout(timer);
    await cleanup?.();
    if (watchdog?.exitCode === null) watchdog.kill("SIGKILL");
    await watchdog?.exited;
    await rm(cwd, { recursive: true, force: true });
  }
}
