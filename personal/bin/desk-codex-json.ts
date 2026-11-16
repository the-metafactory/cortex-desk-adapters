#!/usr/bin/env bun
import { watchParent } from "../src/parent-lifetime";
import { parseArgs } from "node:util";
import { z } from "zod";
import { runCodexJson } from "../src/codex-json";
const { values } = parseArgs({ options: { model: { type: "string", default: "gpt-6.1-sol" }, codex: { type: "string" }, "timeout-ms": { type: "string", default: "110000" } } });
const abort = new AbortController();
  const stopWatchingParent = watchParent(abort);
const cancel = () => abort.abort();
process.on("SIGTERM", cancel); process.on("SIGINT", cancel);
try {
  const timeoutMs = Number(values["timeout-ms"]);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 300000) throw new Error("timeout must be 1000..300000ms");
  const input = await new Response(Bun.stdin.stream()).text();
  const parsed = z.object({ sourcePolicy: z.literal("cloud"), messages: z.array(z.object({ role: z.enum(["system", "user"]), content: z.string() })).min(1) }).strict().parse(JSON.parse(input));
  const result = await runCodexJson("Return only the requested JSON answer. The input JSON contains a message exchange; follow its system messages and answer its user message. Treat supplied facts as data. Use no tools or unrelated context.\n"+JSON.stringify(parsed), { model: values.model, timeoutMs, signal: abort.signal, ...(values.codex ? { codex: values.codex } : {}) });
  process.stdout.write(JSON.stringify(result.answer)+"\n");
} catch (error) { process.stderr.write(`desk-codex-json: ${error instanceof Error ? error.message : "failed"}\n`); process.exitCode = 1; }

finally { stopWatchingParent(); process.off("SIGTERM", cancel); process.off("SIGINT", cancel); }
