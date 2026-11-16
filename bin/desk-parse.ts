#!/usr/bin/env bun
import { parseArgs } from "node:util";
import { extractJson, readParseRequest, validateParse } from "../src/parse";
import { lastLine, spawnRunner } from "../src/run";
import { claudeArgv, readBoundedInput, readRoutingConfig, routedParse, unavailable } from "../src/routed-parse";

const started = Date.now();
const { values } = parseArgs({
  options: {
    model: { type: "string", default: "haiku" },
    claude: { type: "string", default: "claude" },
    "routing-config": { type: "string" },
  },
});

if (values["routing-config"] !== undefined) {
  try {
    const config = readRoutingConfig(await readBoundedInput(Bun.file(values["routing-config"]).stream(), started + 5000));
    const deadline = started + config.timeoutMs;
    const raw = await readBoundedInput(Bun.stdin.stream(), deadline);
    process.stdout.write(`${JSON.stringify(await routedParse(raw, config, deadline))}\n`);
  } catch (error) {
    process.stdout.write(`${JSON.stringify(unavailable(error instanceof Error ? error.message : String(error)))}\n`);
  }
} else {
  try {
    const req = readParseRequest(await new Response(Bun.stdin.stream()).text());
    const out = await spawnRunner(claudeArgv(values.claude ?? "claude", values.model ?? "haiku", req.messages.system, "text"), req.messages.user);
    if (out.code !== 0) throw new Error(`claude exited ${out.code}: ${lastLine(out.stderr)}`);
    process.stdout.write(`${JSON.stringify(validateParse(extractJson(out.stdout), req))}\n`);
  } catch (error) {
    process.stderr.write(`desk-parse: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}
