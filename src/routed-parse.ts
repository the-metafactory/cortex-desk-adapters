import { spawn } from "node:child_process";
import type { DeskParseResult } from "./contract";
import { isRecord } from "./guards";
import { extractJson, readParseRequest, validateParse } from "./parse";

export type Provider = "claude" | "codex" | "pi";
type Backend = { command: string; model: string; provider: string };
export type RoutingConfig = { version: 1; ranger: { command: string; config: string }; timeoutMs: number; permitted: Provider[]; providers: Partial<Record<Provider, Backend>> };
type Candidate = { substrate: Provider; reason: string };
type Selection = { candidates: Candidate[] } & ({ kind: "selected"; substrate: Provider; reason: "most-headroom" | "pi-fallback" } | { kind: "unavailable"; reason: string });
type Evidence = { attempted: Provider[]; candidates: Candidate[]; fallbackReasons: { provider: Provider; reason: string }[]; capabilityExclusions: { provider: Provider; reason: string }[] };
const PROVIDERS: Provider[] = ["claude", "codex", "pi"];
const isProvider = (v: unknown): v is Provider => v === "claude" || v === "codex" || v === "pi";
const isText = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0;
const message = (v: unknown) => v instanceof Error ? v.message : String(v);
const LIMIT = 256 * 1024;

function providers(v: unknown): Provider[] {
  if (!Array.isArray(v) || !v.every(isProvider) || new Set(v).size !== v.length) throw new Error("invalid permitted providers");
  return v;
}

export function readRoutingConfig(raw: string): RoutingConfig {
  const v: unknown = JSON.parse(raw);
  if (!isRecord(v) || v.version !== 1 || !isRecord(v.ranger) || !isText(v.ranger.command) || !isText(v.ranger.config) || !Number.isSafeInteger(v.timeoutMs) || typeof v.timeoutMs !== "number" || v.timeoutMs <= 0 || v.timeoutMs > 300_000 || !isRecord(v.providers)) throw new Error("invalid routing configuration");
  const configured: Partial<Record<Provider, Backend>> = {};
  for (const key of Object.keys(v.providers)) {
    if (!isProvider(key)) throw new Error("unknown configured provider");
    const b = v.providers[key];
    if (!isRecord(b) || !isText(b.command) || !isText(b.model)) throw new Error(`invalid ${key} configuration`);
    if (key === "pi" && (!isText(b.provider) || b.provider === "openai-codex" || b.provider === "anthropic")) throw new Error("pi requires an independent provider; anthropic and openai-codex belong to claude and codex");
    configured[key] = { command: b.command, model: b.model, provider: key === "pi" && isText(b.provider) ? b.provider : key === "codex" ? "openai-codex" : "anthropic" };
  }
  return { version: 1, ranger: { command: v.ranger.command, config: v.ranger.config }, timeoutMs: v.timeoutMs, permitted: providers(v.permitted), providers: configured };
}

export async function readBoundedInput(stream: ReadableStream<Uint8Array>, deadline: number, limit = 65536): Promise<string> {
  const reader = stream.getReader();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const read = async () => {
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const next = await reader.read();
      if (next.done) return Buffer.concat(chunks).toString("utf8");
      size += next.value.byteLength;
      if (size > limit) throw new Error("input exceeds size limit");
      chunks.push(next.value);
    }
  };
  try {
    return await Promise.race([read(), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("deadline exceeded")), Math.max(0, deadline - Date.now())); })]);
  } finally {
    clearTimeout(timer);
    void reader.cancel().catch(() => {});
  }
}

export function runBounded(argv: string[], stdin: string, deadline: number, stopOnPiError = false): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const [command, ...args] = argv;
    if (!command || Date.now() >= deadline) { reject(new Error("deadline exceeded")); return; }
    const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"], detached: process.platform !== "win32" });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let size = 0;
    let finished = false;
    const killGroup = () => {
      try {
        if (process.platform !== "win32" && child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch { child.kill("SIGKILL"); }
    };
    const stop = (error: Error) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      killGroup();
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
      reject(error);
    };
    const timer = setTimeout(() => stop(new Error("deadline exceeded")), Math.max(0, deadline - Date.now()));
    const collect = (chunk: Buffer, channel: "stdout" | "stderr") => {
      size += chunk.byteLength;
      if (size > LIMIT) { stop(new Error("command output exceeds size limit")); return; }
      if (channel === "stdout") stdout.push(chunk); else stderr.push(chunk);
      if (stopOnPiError && channel === "stdout") {
        const output = Buffer.concat(stdout).toString("utf8");
        const completeLines = output.slice(0, output.lastIndexOf("\n")).split("\n");
        const failed = completeLines.some(line => {
          try {
            const event: unknown = JSON.parse(line);
            return isRecord(event) && event.type === "message_end" && isRecord(event.message) && event.message.role === "assistant" && event.message.stopReason === "error";
          } catch { return false; }
        });
        if (failed && !finished) {
          finished = true;
          clearTimeout(timer);
          killGroup();
          child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy();
          resolve({ code: 1, stdout: output, stderr: Buffer.concat(stderr).toString("utf8") });
        }
      }
    };
    child.stdout.on("data", (chunk: Buffer) => collect(chunk, "stdout"));
    child.stderr.on("data", (chunk: Buffer) => collect(chunk, "stderr"));
    child.on("error", stop);
    child.stdin.on("error", stop);
    child.on("close", code => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      killGroup();
      resolve({ code: code ?? -1, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") });
    });
    child.stdin.end(stdin);
  });
}

const PI_FLAGS = ["--no-tools", "--no-extensions", "--no-mcp", "--no-skills", "--no-prompt-templates", "--no-context-files", "--no-session", "--print", "--mode", "--system-prompt", "--provider", "--model", "--thinking"];
const CLAUDE_FLAGS = ["--tools", "--strict-mcp-config", "--mcp-config", "--no-session-persistence", "--disable-slash-commands", "--setting-sources", "--output-format", "--print", "--model", "--safe-mode", "--system-prompt"];
export function claudeArgv(command: string, model: string, system: string, format: "json" | "text" = "json"): string[] {
  return [command, "--tools", "", "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}', "--no-session-persistence", "--disable-slash-commands", "--setting-sources", "", "--safe-mode", "--system-prompt", system, "--output-format", format, "--print", "--model", model];
}
export function providerArgv(name: Provider, backend: Backend, system: string): string[] {
  if (name === "claude") return claudeArgv(backend.command, backend.model, system);
  return [backend.command, "--no-tools", "--no-extensions", "--no-mcp", "--no-skills", "--no-prompt-templates", "--no-context-files", "--no-session", "--print", "--mode", "json", "--thinking", "off", "--system-prompt", system, "--provider", backend.provider, "--model", backend.model];
}

export function readSelection(raw: string): Selection {
  const v: unknown = JSON.parse(raw);
  if (!isRecord(v) || v.version !== 1 || !Array.isArray(v.candidates)) throw new Error("invalid selector envelope");
  const candidates: Candidate[] = [];
  const reasons = ["not-configured", "not-permitted", "already-attempted", "parser-incapable", "missing-reading", "stale-reading", "capped", "quota-ineligible", "eligible"];
  for (const c of v.candidates) {
    if (!isRecord(c) || !isProvider(c.substrate) || typeof c.reason !== "string" || !reasons.includes(c.reason) || candidates.some(x => x.substrate === c.substrate)) throw new Error("invalid selector candidates");
    candidates.push({ substrate: c.substrate, reason: c.reason });
  }
  if ((v.kind === "selected" || v.reason === "no-eligible-substrate") && candidates.length !== 3) throw new Error("incomplete selector candidates");
  if (v.kind === "unavailable" && typeof v.reason === "string" && ["no-eligible-substrate", "invalid-request", "integration-unavailable"].includes(v.reason)) {
    if (v.reason !== "no-eligible-substrate" && candidates.length !== 0) throw new Error("invalid unavailable selector candidates");
    return { kind: "unavailable", reason: v.reason, candidates };
  }
  if (v.kind !== "selected" || !isProvider(v.substrate) || (v.reason !== "most-headroom" && v.reason !== "pi-fallback") || (v.reason === "pi-fallback") !== (v.substrate === "pi") || !candidates.some(c => c.substrate === v.substrate && c.reason === "eligible")) throw new Error("invalid selector decision");
  return { kind: "selected", substrate: v.substrate, reason: v.reason, candidates };
}

const quota = (v: unknown): boolean => v === 429 || v === "429" || v === "usage_limit" || v === "rate_limit" || v === "rate_limit_error" || v === "usage_limit_reached";
function quotaError(v: unknown): boolean {
  return isRecord(v) && (quota(v.api_error_status) || quota(v.api_error) || quota(v.type) || quota(v.code) || quota(v.status) || quota(v.error) || (typeof v.errorMessage === "string" && /\b(?:usage_limit|rate_limit|429)\b/.test(v.errorMessage)) || (isRecord(v.error) && quotaError(v.error)));
}
export function readCompletion(name: Provider, raw: string, code: number): { kind: "complete"; text: string } | { kind: "quota" } {
  if (name === "claude") {
    const v: unknown = JSON.parse(raw);
    if (!isRecord(v) || v.type !== "result" || typeof v.is_error !== "boolean") throw new Error("invalid Claude completion envelope");
    if (code === 0 && v.is_error === false && v.subtype === "success" && typeof v.result === "string") return { kind: "complete", text: v.result };
    if (v.is_error && quotaError(v)) return { kind: "quota" };
    throw new Error("Claude did not complete successfully");
  }
  let terminal: Record<string, unknown> | undefined;
  for (const line of raw.split("\n").filter(line => line.trim())) {
    const v: unknown = JSON.parse(line);
    if (!isRecord(v) || typeof v.type !== "string") throw new Error("invalid Pi event");
    if (v.type === "error") throw new Error("Pi reported an error event");
    if (v.type === "tool_execution_start" || v.type === "tool_execution_end") throw new Error("Pi attempted a tool");
    if (v.type === "message_end") {
      if (!isRecord(v.message)) throw new Error("invalid Pi terminal message");
      if (v.message.role === "user" || v.message.role === "system") continue;
      if (v.message.role !== "assistant") throw new Error("invalid Pi terminal message");
      if (terminal !== undefined) throw new Error("Pi returned multiple assistant completions");
      terminal = v.message;
    }
  }
  if (!terminal) throw new Error("missing Pi completion");
  if (terminal.stopReason === "error" && quotaError(terminal)) return { kind: "quota" };
  if (code !== 0 || terminal.stopReason !== "stop" || !Array.isArray(terminal.content)) throw new Error("Pi did not complete successfully");
  let text = "";
  for (const c of terminal.content) {
    if (!isRecord(c) || (c.type !== "text" && c.type !== "thinking")) throw new Error("unexpected Pi content");
    if (c.type === "text") { if (typeof c.text !== "string") throw new Error("invalid Pi text"); text += c.text; }
  }
  return { kind: "complete", text };
}

export function unavailable(reason: string, evidence: Evidence = { attempted: [], candidates: [], fallbackReasons: [], capabilityExclusions: [] }) {
  return { kind: "none", reason: `Parser unavailable: ${reason}`, routing: { version: 1, kind: "unavailable", reason, ...evidence } };
}

export async function routedParse(raw: string, config: RoutingConfig, deadline: number) {
  const evidence: Evidence = { attempted: [], candidates: [], fallbackReasons: [], capabilityExclusions: [] };
  try {
    const body: unknown = JSON.parse(raw);
    let permitted = config.permitted;
    if (isRecord(body) && body.routing !== undefined) {
      if (!isRecord(body.routing) || Object.keys(body.routing).some(key => key !== "permitted") || body.routing.permitted === undefined) throw new Error("invalid request routing");
      const restriction = providers(body.routing.permitted);
      permitted = permitted.filter(p => restriction.includes(p));
    }
    const request = readParseRequest(raw);
    const capable: Provider[] = [];
    type Capability = { provider: Provider; kind: "capable" } | { provider: Provider; kind: "excluded"; reason: string };
    const checks = await Promise.all(PROVIDERS.filter(provider => permitted.includes(provider)).map(async (provider): Promise<Capability> => {
      const backend = config.providers[provider];
      if (!backend) return { provider, kind: "excluded", reason: "not configured" };
      try {
        const help = await runBounded([backend.command, "--help"], "", deadline);
        const flags = provider === "claude" ? CLAUDE_FLAGS : PI_FLAGS;
        const advertised = new Set(`${help.stdout}\n${help.stderr}`.match(/--[a-z][a-z-]*/g) ?? []);
        if (help.code !== 0 || !flags.every(flag => advertised.has(flag))) throw new Error("required tools-disabled flags unavailable");
        return { provider, kind: "capable" };
      } catch (error) { return { provider, kind: "excluded", reason: message(error) }; }
    }));
    for (const check of checks) {
      if (check.kind === "capable") capable.push(check.provider);
      else evidence.capabilityExclusions.push({ provider: check.provider, reason: check.reason });
    }
    while (evidence.attempted.length < PROVIDERS.length) {
      const selectionOutput = await runBounded([config.ranger.command, "select-substrate", "--config", config.ranger.config], JSON.stringify({ version: 1, permitted, attempted: evidence.attempted, parserCapable: capable }), deadline);
      if (selectionOutput.code !== 0) throw new Error("selector command failed");
      const selection = readSelection(selectionOutput.stdout);
      evidence.candidates = selection.candidates;
      if (selection.kind === "unavailable") return unavailable(selection.reason, evidence);
      const provider = selection.substrate;
      if (!permitted.includes(provider) || !capable.includes(provider) || evidence.attempted.includes(provider)) throw new Error("selector chose an ineligible provider");
      const backend = config.providers[provider];
      if (!backend) throw new Error("selector chose an unconfigured provider");
      evidence.attempted.push(provider);
      const output = await runBounded(providerArgv(provider, backend, request.messages.system), request.messages.user, deadline, provider !== "claude");
      const completion = readCompletion(provider, output.stdout, output.code);
      if (completion.kind === "quota") { evidence.fallbackReasons.push({ provider, reason: "quota-exhausted" }); continue; }
      const result: DeskParseResult = validateParse(extractJson(completion.text), request);
      return { ...result, routing: { version: 1, kind: "selected", provider, reason: selection.reason, ...evidence } };
    }
    return unavailable("all providers attempted", evidence);
  } catch (error) { return unavailable(message(error), evidence); }
}
