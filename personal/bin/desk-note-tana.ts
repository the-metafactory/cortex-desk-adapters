#!/usr/bin/env bun
/**
 * desk-note-tana: a Desk writer that files `{ "kind": "note", "fields": { "text" }, "requestId" }` from stdin
 * as one plain node in Tana through the Input API, once per Desk request id.
 * Usage: desk-note-tana [--target <nodeId>]   (default INBOX)
 * The token comes from TANA_API_TOKEN or supertag's config (~/.config/supertag/config.json), never from argv.
 */
import { parseArgs } from "node:util";
import { ledgerPath, tanaAccess, writeNote } from "../src/tana";
import { readRequest, requireRequestId, runWriter } from "../../src/writers";

const { values } = parseArgs({
  options: {
    target: { type: "string" },
  },
});

await runWriter((text) => {
  const input = readRequest(text, "note");
  return writeNote(input.fields, {
    requestId: requireRequestId(input),
    target: values.target ?? "INBOX",
    access: () => tanaAccess(process.env),
    fetch: (url, init) => fetch(url, init),
    ledgerPath: ledgerPath(process.env),
  });
});
