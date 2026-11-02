#!/usr/bin/env bun
/**
 * desk-task-close: closes a task desk-task filed, from `{ "action": "close", "task", "outcome", "receipt" }` on stdin:
 * completed when approved, not planned when discarded. Usage: desk-task-close --map owner/name#N... [--gh gh]
 */
import { parseArgs } from "node:util";
import { spawnRunner } from "../src/run";
import { closeTask, readCloseRequest } from "../src/task-close";
import { runWriter } from "../src/writers";

const { values } = parseArgs({
  options: {
    map: { type: "string", multiple: true, default: [] },
    gh: { type: "string", default: "gh" },
  },
});

await runWriter((text) => closeTask(readCloseRequest(text), { gh: values.gh ?? "gh", run: spawnRunner, maps: values.map ?? [] }));
