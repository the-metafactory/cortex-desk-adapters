import type { DeskTaskCloseRequest, DeskWriteResult } from "./contract";
import { isRecord } from "./guards";
import { lastLine, type Runner } from "./run";
import { Refusal, TASK_LABEL } from "./writers";

const PLAIN_REF = /^([\w.-]+\/[\w.-]+)#([1-9]\d*)$/;
const QUALIFIED_REF = /^github:([\w.-]+)\/([\w.-]+\/[\w.-]+)#([1-9]\d*)$/;
const NOT_A_REF = "is not a ref like owner/name#123 or github:host/owner/name#123.";

interface Ref {
  /** As gh -R takes it: owner/name on github.com, else host/owner/name. */
  repo: string;
  /** host/owner/name in lower case, to compare a task with a map. */
  key: string;
  num: string;
}

/** An owner/name#N ref (github.com) or a qualified github:host/owner/name#N, as desk-task files them. */
export function parseRef(ref: string): Ref | null {
  const plain = PLAIN_REF.exec(ref);
  if (plain?.[1] && plain[2]) return { repo: plain[1], key: `github.com/${plain[1]}`.toLowerCase(), num: plain[2] };
  const q = QUALIFIED_REF.exec(ref);
  if (!q?.[1] || !q[2] || !q[3]) return null;
  const host = q[1].toLowerCase();
  return { repo: host === "github.com" ? q[2] : `${host}/${q[2]}`, key: `${host}/${q[2]}`.toLowerCase(), num: q[3] };
}
const RECEIPT = /^[\w:.-]{1,100}$/;
const OUTCOMES = { approved: { word: "Approved", reason: "completed", said: "done" }, discarded: { word: "Discarded", reason: "not planned", said: "not planned" } } as const;

/** Parses the close request, refusing anything but `{ action: "close", task, outcome, receipt }`. */
export function readCloseRequest(text: string): DeskTaskCloseRequest {
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Refusal("The request is not valid JSON.");
  }
  if (!isRecord(body) || body.action !== "close") throw new Refusal("This command only closes tasks.");
  const { task, outcome, receipt } = body;
  if (typeof task !== "string" || !parseRef(task)) throw new Refusal(`The task ${NOT_A_REF}`);
  if (outcome !== "approved" && outcome !== "discarded") throw new Refusal("The outcome is not approved or discarded.");
  if (typeof receipt !== "string" || !RECEIPT.test(receipt)) throw new Refusal("The receipt is not 1 to 100 letters, digits, colons, dots, dashes or underscores.");
  return { action: "close", task, outcome, receipt };
}

export const closeMarker = (receipt: string): string => `<!-- desk:close ${receipt} -->`;

/** The only text the close leaves on the task: the decision and the Desk receipt, never mail content. */
export const closeComment = (outcome: DeskTaskCloseRequest["outcome"], receipt: string): string =>
  `${OUTCOMES[outcome].word} on the Cortex Desk. Desk receipt: ${receipt}.\n\n${closeMarker(receipt)}`;

interface Issue {
  state: string;
  url?: string;
  labels: string[];
  comments: string[];
}

function issueOf(stdout: string): Issue {
  let body: unknown;
  try {
    body = JSON.parse(stdout);
  } catch {
    throw new Refusal("gh answered in a form this command cannot read.");
  }
  if (!isRecord(body) || typeof body.state !== "string") throw new Refusal("gh answered without the task's state.");
  const names = (list: unknown, field: string): string[] => (Array.isArray(list) ? list.flatMap((x) => (isRecord(x) && typeof x[field] === "string" ? [x[field]] : [])) : []);
  return { state: body.state, ...(typeof body.url === "string" ? { url: body.url } : {}), labels: names(body.labels, "name"), comments: names(body.comments, "body") };
}

export interface CloseOptions {
  gh: string;
  run: Runner;
  /** Map refs whose repo may be closed in; at least one. */
  maps: string[];
}

/**
 * Closes a Desk-filed task once: completed for an approved hand-off, not planned for a discarded one. Only issues in a
 * configured map's repo with the Desk intake label. A closed issue is left as it is; a retry posts no second comment.
 */
export async function closeTask(req: DeskTaskCloseRequest, opts: CloseOptions): Promise<DeskWriteResult> {
  if (opts.maps.length === 0) throw new Refusal("No --map is set, so this command may close nothing.");
  const task = parseRef(req.task);
  if (!task) throw new Refusal(`The task ${NOT_A_REF}`);
  const mapKeys = opts.maps.map((map) => {
    const ref = parseRef(map);
    if (!ref) throw new Refusal(`The map "${map}" ${NOT_A_REF}`);
    return ref.key;
  });
  if (!mapKeys.includes(task.key)) throw new Refusal(`The task ${req.task} is not on a map this command may close in.`);
  const gh = async (verb: string, sub: string[], flags: string[]): Promise<string> => {
    const out = await opts.run([opts.gh, "issue", ...sub, task.num, "-R", task.repo, ...flags]);
    if (out.code !== 0) throw new Refusal(`gh could not ${verb} ${req.task}: ${lastLine(out.stderr) || `exit ${out.code}`}`);
    return out.stdout;
  };
  const issue = issueOf(await gh("read", ["view"], ["--json", "state,stateReason,labels,comments,url"]));
  const url = issue.url && /^https?:/i.test(issue.url) ? { url: issue.url } : {};
  if (!issue.labels.includes(TASK_LABEL)) throw new Refusal(`${req.task} is not a Desk task (no ${TASK_LABEL} label), so it is left open.`);
  if (issue.state.toUpperCase() !== "OPEN") return { id: req.task, ...url, message: `${req.task} was already closed; nothing changed.` };
  const outcome = OUTCOMES[req.outcome];
  if (!issue.comments.some((c) => c.includes(closeMarker(req.receipt)))) {
    await gh("comment on", ["comment"], ["--body", closeComment(req.outcome, req.receipt)]);
  }
  await gh("close", ["close"], ["--reason", outcome.reason]);
  return { id: req.task, ...url, message: `Closed ${req.task} as ${outcome.said}.` };
}
