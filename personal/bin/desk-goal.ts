#!/usr/bin/env bun
/**
 * desk-goal: a Desk writer that adds a draft Soma goal from `{ "kind": "goal", "fields": { "wording" } }` on stdin,
 * or returns the goal that already has that wording.
 * Usage: desk-goal [--soma soma]
 */
import { parseArgs } from "node:util";
import { spawnRunner } from "../../src/run";
import { readRequest, runWriter, writeGoal } from "../../src/writers";

const { values } = parseArgs({
  options: {
    soma: { type: "string", default: "soma" },
  },
});

await runWriter((text) => writeGoal(readRequest(text, "goal").fields, { soma: values.soma ?? "soma", run: spawnRunner }));
