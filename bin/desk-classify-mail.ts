#!/usr/bin/env bun
/**
 * desk-classify-mail: the Desk's mail classifier command. Reads one classifier request on stdin, runs the
 * triage flow (a Pulse research step on one OpenAI-compatible model) and prints one JSON answer.
 * Usage: desk-classify-mail --flow <yaml> --base-url <url up to /v1> --model <name> [--key-env DESK_CLASSIFIER_KEY]
 *        [--ca-file <pem>] [--actions-dir <dir>]... [--mail-accounts work,personal] [--state-dir <dir>]
 *        [--timeout-ms <1000..300000>]
 * Any failure exits non-zero with one line on stderr. The total deadline is the model budget plus 3 s.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { watchParent } from "../src/parent-lifetime";
import { parseArgs } from "node:util";
import { classifyMail, withCa } from "../src/classify-mail";
import { CodexChatModel } from "../src/codex-chat-model";
import { personalFlow } from "../src/personal-scope";
import { pulse } from "../src/pulse";
import { readTriageRequest } from "../src/triage";

const DEFAULT_TIMEOUT_MS = 60_000;
class DeadlineExceeded extends Error {}

function fail(message: string, code = 1): never {
  process.stderr.write(`desk-classify-mail: ${message.split("\n")[0] ?? message}\n`);
  process.exit(code);
}

try {
  const { values } = parseArgs({
    options: {
      flow: { type: "string" },
      "base-url": { type: "string" },
      model: { type: "string" },
      codex: { type: "string" },
      "cloud-sources": { type: "string" },
      "cloud-areas": { type: "string" },
      "key-env": { type: "string", default: "DESK_CLASSIFIER_KEY" },
      "ca-file": { type: "string" },
      "actions-dir": { type: "string", multiple: true },
      "mail-accounts": { type: "string" },
      "state-dir": { type: "string" },
      "timeout-ms": { type: "string" },
    },
  });
  const flow = values.flow;
  const baseUrl = values["base-url"];
  const model = values.model;
  if (!flow || !model || (!baseUrl && !values.codex)) fail("--flow, --model and either --base-url or --codex are required", 2);
  const rawTimeout = values["timeout-ms"];
  const timeoutMs = rawTimeout === undefined ? DEFAULT_TIMEOUT_MS : Number(rawTimeout);
  if ((rawTimeout !== undefined && !/^\d+$/.test(rawTimeout)) || !Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 300_000) {
    fail("--timeout-ms must be an integer from 1000 to 300000", 2);
  }
  const deadlineMs = timeoutMs + 3000;
  const abort = new AbortController();
  const stopWatchingParent = watchParent(abort);
  const cancel = () => abort.abort();
  process.on("SIGTERM", cancel); process.on("SIGINT", cancel);
  const deadline = setTimeout(() => abort.abort(new DeadlineExceeded(`no answer within ${deadlineMs / 1000} s`)), deadlineMs);
  if (values["mail-accounts"]) process.env.PULSE_MAIL_ACCOUNTS = values["mail-accounts"];
  const caFile = values["ca-file"];
  const ca = caFile ? await Bun.file(caFile).text().catch(() => fail(`the CA file could not be read: ${caFile}`, 2)) : null;
  const state = values["state-dir"] ?? join(process.env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "cortex-desk-adapters");
  const stopped = new Promise<never>((_, reject) => abort.signal.addEventListener("abort", () => reject(abort.signal.reason), { once: true }));
  const request = readTriageRequest(await Promise.race([new Response(Bun.stdin.stream()).text(), stopped]));
  const scoped = values.codex ? await personalFlow(request, flow, (values["mail-accounts"] ?? "").split(",").map(s => s.trim()).filter(Boolean), timeoutMs, (values["cloud-sources"] ?? "").split(",").filter(Boolean), (values["cloud-areas"] ?? "").split(",").filter(Boolean)) : undefined;
  const started = Date.now();
  const running = classifyMail(request, {
    flow: scoped?.flow ?? flow,
    model: values.codex ? new CodexChatModel({ codex: values.codex, model, timeoutMs, signal: abort.signal }) : new pulse.OpenAICompatibleChatModel({
      baseUrl: baseUrl ?? "",
      model,
      apiKeyEnv: values["key-env"],
      label: "triage",
      timeoutMs,
      ...(ca ? { fetch: withCa(ca) } : {}),
    }),
    actionDirs: [...(scoped?.actionDirs ?? []), ...(values["actions-dir"] ?? [join(homedir(), ".config", "metafactory", "arc", "actions")])],
    transcriptDir: join(state, "desk-classify-mail", "transcripts"),
  });
  const result = await Promise.race([running, stopped]).finally(async () => { await Promise.race([running.catch(() => undefined), Bun.sleep(500)]); await scoped?.close(); stopWatchingParent(); clearTimeout(deadline); process.off("SIGTERM", cancel); process.off("SIGINT", cancel); });
  clearTimeout(deadline);
  process.stdout.write(`${JSON.stringify(result.answer)}\n`);
  process.stderr.write(`desk-classify-mail: ${result.answer.category} in ${Date.now() - started} ms, ${result.rounds} rounds, ${result.toolCalls} tool calls\n`);
  process.exit(0);
} catch (error) {
  fail(error instanceof Error ? error.message : String(error), error instanceof DeadlineExceeded ? 3 : 1);
}
