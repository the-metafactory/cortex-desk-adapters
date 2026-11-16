import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DeskGoalFields, DeskTaskFields, DeskWriteInput, DeskWriteKind } from "./cortex-contract";
import type { DeskWriteResult } from "./contract";
import { isRecord } from "./guards";
import { lastLine, type Runner } from "./run";

/** A refusal: its message is one plain sentence, shown to the person as the last line of stderr. */
export class Refusal extends Error {}

/** A writer's stdin after the envelope check: fields still unchecked, the request id present only if Cortex sent one. */
export type WriterInput<K extends DeskWriteKind = DeskWriteKind> = {
  kind: K;
  fields: Record<string, unknown>;
  requestId?: DeskWriteInput["requestId"];
};

const REQUEST_ID = /^[\w-]{8,64}$/;

/** Parses the writer input once, refusing it unless it is JSON of the expected kind with a well-formed request id, if any. */
export function readRequest<K extends DeskWriteKind>(text: string, kind: K): WriterInput<K> {
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Refusal("The request is not valid JSON.");
  }
  if (!isRecord(body) || !isRecord(body.fields)) throw new Refusal("The request has no fields.");
  if (body.kind !== kind) throw new Refusal(`This writer handles ${kind} requests, not ${JSON.stringify(body.kind)}.`);
  const { requestId } = body;
  if (requestId === undefined) return { kind, fields: body.fields };
  if (typeof requestId !== "string" || !REQUEST_ID.test(requestId)) throw new Refusal("The request id is not 8 to 64 letters, digits, dashes or underscores.");
  return { kind, fields: body.fields, requestId };
}

/** A single-line text field; soma reads a value that starts with "--" as a flag, so that is refused too. */
function line(fields: Record<string, unknown>, name: string, max: number): string {
  const v = fields[name];
  if (typeof v !== "string" || !v.trim()) throw new Refusal(`The ${name} is missing.`);
  const t = v.trim();
  if (/[\r\n]/.test(t)) throw new Refusal(`The ${name} must be a single line.`);
  if (t.startsWith("--")) throw new Refusal(`The ${name} must not start with "--".`);
  if (t.length > max) throw new Refusal(`The ${name} is longer than ${max} characters.`);
  return t;
}

export const TASK_LABEL = "desk:principal-intake";

/** The request id a writer needs to dedupe: without it a retry could file the item twice. */
export function requireRequestId(input: WriterInput): string {
  if (input.requestId === undefined) throw new Refusal("The request has no request id, so a retry could file it twice.");
  return input.requestId;
}

export const onceMarker = (requestId: string): string => `<!-- desk:request ${requestId} -->`;

export function goalFields(fields: Record<string, unknown>): DeskGoalFields {
  return { wording: line(fields, "wording", 500) };
}

export function taskFields(fields: Record<string, unknown>): DeskTaskFields {
  const title = line(fields, "title", 200);
  const map = line(fields, "map", 200);
  const details = fields.details;
  if (details !== undefined && typeof details !== "string") throw new Refusal("The details must be text.");
  return { title, map, ...(details?.trim() ? { details: details.trim() } : {}) };
}

/** `soma goal add` prints the new goal's id (G<n>) on a line of its own; the goal starts as a draft. */
export function goalIdFrom(stdout: string): string | undefined {
  return stdout.split("\n").map((l) => l.trim()).find((l) => /^G\d+$/.test(l));
}

/**
 * `soma goal list --wording` prints one goal per line, tab-separated:
 * `G<n>\t<status>\tsupports: [M0, ...]\tsensor: <id or ->\t<wording>`. Returns the first goal whose wording is the same.
 */
const OPEN_GOAL = new Set(["draft", "active", "paused"]);

export function goalWithWording(stdout: string, wording: string): string | undefined {
  for (const row of stdout.split("\n")) {
    const cells = row.split("\t");
    const id = cells[0]?.trim() ?? "";
    if (!/^G\d+$/.test(id) || cells.length < 5 || !OPEN_GOAL.has(cells[1]?.trim() ?? "")) continue;
    if (cells.slice(4).join("\t").trim() === wording) return id;
  }
  return undefined;
}

/**
 * soma goal add has no dedupe key, so the wording is the key: a goal with the same wording is returned
 * instead of a second one. A retry of one Desk card therefore adds nothing; the request id is not needed.
 */
export async function writeGoal(fields: Record<string, unknown>, opts: { soma: string; run: Runner }): Promise<DeskWriteResult> {
  const { wording } = goalFields(fields);
  const listed = await opts.run([opts.soma, "goal", "list", "--wording"]);
  if (listed.code !== 0) throw new Refusal(`soma could not list the goals: ${lastLine(listed.stderr) || `exit ${listed.code}`}`);
  const existing = goalWithWording(listed.stdout, wording);
  if (existing) return { id: existing, message: `Goal ${existing} already says "${wording}"; nothing new was added.` };
  const out = await opts.run([opts.soma, "goal", "add", "--wording", wording]);
  if (out.code !== 0) throw new Refusal(`soma could not add the goal: ${lastLine(out.stderr) || `exit ${out.code}`}`);
  const id = goalIdFrom(out.stdout);
  if (!id) throw new Refusal("soma added a goal but printed no goal id.");
  return { id, message: `Added goal ${id} as a draft: "${wording}".` };
}

/** "Plan the Q1 offsite!" → "desk-plan-the-q1-offsite", at most 48 characters, cut at a dash. */
export function checkpointSlug(title: string, max = 48): string {
  const kebab = title.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  let slug = `desk-${kebab || "task"}`;
  if (slug.length > max) {
    slug = slug.slice(0, max);
    const cut = slug.lastIndexOf("-");
    if (cut > "desk-".length) slug = slug.slice(0, cut);
  }
  return slug.replace(/-+$/, "");
}

/** The node body: the question an orienteer node carries, plus where it came from. */
export function taskBody(fields: DeskTaskFields, now: Date): string {
  return [
    "## Question",
    "",
    fields.details ?? fields.title,
    "",
    `Filed from the Cortex Desk on ${now.toISOString().slice(0, 10)}.`,
    "",
  ].join("\n");
}

/**
 * The map as `soma graph add` takes it. `owner/name#N` gets an explicit github.com `--repo`, so the
 * store does not depend on the directory Cortex runs the writer from; a qualified ref names its own.
 */
export function mapTarget(map: string): { target: string; repo?: string } {
  if (/^[\w.-]+\/[\w.-]+#[1-9]\d*$/.test(map)) return { target: map, repo: `github:github.com/${map.split("#")[0]}` };
  if (/^(github|gitlab):[\w.-]+\/[\w./-]+#[1-9]\d*$/.test(map)) return { target: map };
  throw new Refusal(`"${map}" is not a map ref like owner/name#123.`);
}

/** `soma graph add --json` prints `{ repo, node, parent, blockedBy }`, plus `existing` with `--once` (the-metafactory/soma#1145); on github.com repo is owner/name, node the issue number. */
export function createdNode(stdout: string): DeskWriteResult & { existing: boolean } {
  let body: unknown;
  try {
    body = JSON.parse(stdout);
  } catch {
    throw new Refusal("soma filed the task but its output was not JSON.");
  }
  if (!isRecord(body) || typeof body.node !== "string" || typeof body.repo !== "string") throw new Refusal("soma filed the task but printed no node id.");
  const { repo, node } = body;
  const existing = body.existing === true;
  if (!/^\d+$/.test(node)) return { id: node, existing };
  if (/^[\w.-]+\/[\w.-]+$/.test(repo)) return { id: `${repo}#${node}`, url: `https://github.com/${repo}/issues/${node}`, existing };
  const gh = /^github:([\w.-]+)\/(.+)$/.exec(repo);
  if (gh) return { id: `${repo}#${node}`, url: `https://${gh[1]}/${gh[2]}/issues/${node}`, existing };
  return { id: `${repo}#${node}`, existing };
}

/** With --json, a node created but left unattached is reported as JSON on stderr with `attached: false`. */
function partialNode(stderr: string): string | undefined {
  try {
    const body: unknown = JSON.parse(stderr);
    return isRecord(body) && body.attached === false && typeof body.node === "string" ? body.node : undefined;
  } catch {
    return undefined;
  }
}

export interface TaskOptions {
  soma: string;
  run: Runner;
  /** Allowed map refs; empty allows any. */
  maps: string[];
  autonomy: string;
  kind: string;
  requestId: string;
  now?: Date;
}

export async function writeTask(raw: Record<string, unknown>, opts: TaskOptions): Promise<DeskWriteResult> {
  const fields = taskFields(raw);
  if (opts.maps.length > 0 && !opts.maps.includes(fields.map)) throw new Refusal(`The map ${fields.map} is not one this writer may file to.`);
  if (!["auto", "propose", "approve"].includes(opts.autonomy)) throw new Refusal(`The autonomy ${opts.autonomy} is not auto, propose or approve.`);
  const { target, repo } = mapTarget(fields.map);
  const dir = await mkdtemp(join(tmpdir(), "desk-task-"));
  try {
    const bodyFile = join(dir, "body.md");
    await writeFile(bodyFile, taskBody(fields, opts.now ?? new Date()), { mode: 0o600 });
    const argv = [
      opts.soma, "graph", "add", target,
      "--title", fields.title,
      "--autonomy", opts.autonomy,
      "--checkpoint", checkpointSlug(fields.title),
      "--kind", opts.kind,
      "--label", TASK_LABEL,
      "--once", onceMarker(opts.requestId),
      "--body-file", bodyFile,
      ...(repo ? ["--repo", repo] : []),
      "--json",
    ];
    const out = await opts.run(argv);
    if (out.code !== 0) {
      const partial = partialNode(out.stderr);
      if (partial) throw new Refusal(`soma created node ${partial} but could not attach it to ${fields.map}; finish it with soma graph link.`);
      throw new Refusal(`soma could not file the task: ${lastLine(out.stderr) || `exit ${out.code}`}`);
    }
    const { existing, ...created } = createdNode(out.stdout);
    const message = existing ? `"${fields.title}" was already filed as ${created.id}; nothing new was filed.` : `Filed "${fields.title}" as ${created.id} on ${fields.map}.`;
    return { ...created, message };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Shared bin plumbing: read stdin, write, print the result or the refusal sentence. */
export async function runWriter(write: (text: string) => Promise<DeskWriteResult>): Promise<never> {
  try {
    const result = await write(await new Response(Bun.stdin.stream()).text());
    process.stdout.write(`${JSON.stringify(result)}\n`);
    process.exit(0);
  } catch (error) {
    const sentence = error instanceof Refusal ? error.message : `The writer failed: ${(error as Error).message}`;
    process.stderr.write(`${sentence.replace(/\s*\n\s*/g, " ")}\n`);
    process.exit(1);
  }
}
