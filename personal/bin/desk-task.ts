#!/usr/bin/env bun
/**
 * desk-task: a Desk writer that files `{ "kind": "task", "fields": { "title", "details"?, "map" } }` from stdin
 * as a node on a Soma work-graph map, labelled desk:principal-intake, once per Desk request id.
 * Usage: desk-task [--map owner/name#N]... [--autonomy approve] [--kind research] [--soma soma]
 * With one or more --map, a request naming any other map is refused.
 */
import { parseArgs } from "node:util";
import { spawnRunner } from "../../src/run";
import { readRequest, requireRequestId, runWriter, writeTask } from "../../src/writers";

const { values } = parseArgs({
  options: {
    map: { type: "string", multiple: true, default: [] },
    autonomy: { type: "string", default: "approve" },
    kind: { type: "string", default: "research" },
    soma: { type: "string", default: "soma" },
  },
});

await runWriter((text) => {
  const input = readRequest(text, "task");
  return writeTask(input.fields, {
    soma: values.soma ?? "soma",
    run: spawnRunner,
    maps: values.map ?? [],
    autonomy: values.autonomy ?? "approve",
    kind: values.kind ?? "research",
    requestId: requireRequestId(input),
  });
});
