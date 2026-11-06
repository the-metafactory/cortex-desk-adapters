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
import { parseArgs } from "node:util";
import { classifyMail, withCa } from "../src/classify-mail";
import { pulse } from "../src/pulse";
import { readTriageRequest } from "../src/triage";

const DEFAULT_TIMEOUT_MS = 60_000;

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
  if (!flow || !baseUrl || !model) fail("--flow, --base-url and --model are required", 2);
  const rawTimeout = values["timeout-ms"];
  const timeoutMs = rawTimeout === undefined ? DEFAULT_TIMEOUT_MS : Number(rawTimeout);
  if ((rawTimeout !== undefined && !/^\d+$/.test(rawTimeout)) || !Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 300_000) {
    fail("--timeout-ms must be an integer from 1000 to 300000", 2);
  }
  const deadlineMs = timeoutMs + 3000;
  const deadline = setTimeout(() => fail(`no answer within ${deadlineMs / 1000} s`, 3), deadlineMs);
  if (values["mail-accounts"]) process.env.PULSE_MAIL_ACCOUNTS = values["mail-accounts"];
  const caFile = values["ca-file"];
  const ca = caFile ? await Bun.file(caFile).text().catch(() => fail(`the CA file could not be read: ${caFile}`, 2)) : null;
  const state = values["state-dir"] ?? join(process.env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "cortex-desk-adapters");
  const request = readTriageRequest(await new Response(Bun.stdin.stream()).text());
  const started = Date.now();
  const result = await classifyMail(request, {
    flow,
    model: new pulse.OpenAICompatibleChatModel({
      baseUrl,
      model,
      apiKeyEnv: values["key-env"],
      label: "triage",
      timeoutMs,
      ...(ca ? { fetch: withCa(ca) } : {}),
    }),
    actionDirs: values["actions-dir"] ?? [join(homedir(), ".config", "metafactory", "arc", "actions")],
    transcriptDir: join(state, "desk-classify-mail", "transcripts"),
  });
  clearTimeout(deadline);
  process.stdout.write(`${JSON.stringify(result.answer)}\n`);
  process.stderr.write(`desk-classify-mail: ${result.answer.category} in ${Date.now() - started} ms, ${result.rounds} rounds, ${result.toolCalls} tool calls\n`);
  process.exit(0);
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
