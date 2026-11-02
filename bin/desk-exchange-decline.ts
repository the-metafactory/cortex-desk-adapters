#!/usr/bin/env bun
/**
 * desk-exchange-decline: removes the tentative copy Exchange placed on the calendar for an invitation the Desk declined,
 * from `{ "action": "remove-declined", "account", "uid", "start", "end"?, "recurring"? }` on stdin. Matches by UID only.
 * Usage: desk-exchange-decline --ical-account <name> [--config <ical config.json>]
 */
import { parseArgs } from "node:util";
import { ewsTransport, icalAccount, readDeclinedCopyRequest, removeDeclinedCopy } from "../src/exchange-decline";
import { spawnRunner } from "../src/run";
import { Refusal, runWriter } from "../src/writers";

const { values } = parseArgs({
  options: {
    "ical-account": { type: "string" },
    config: { type: "string" },
  },
});

await runWriter(async (text) => {
  const req = readDeclinedCopyRequest(text);
  const name = values["ical-account"];
  if (!name) throw new Refusal("desk-exchange-decline needs --ical-account.");
  const account = await icalAccount(name, spawnRunner, values.config);
  return removeDeclinedCopy(req, ewsTransport(account));
});
