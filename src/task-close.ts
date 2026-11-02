import type { DeskTaskCloseRequest, DeskWriteResult } from "./contract";
import { isRecord } from "./guards";
import { lastLine, type Runner } from "./run";
import { Refusal, TASK_LABEL } from "./writers";

const TASK_REF = /^([\w.-]+\/[\w.-]+)#([1-9]\d*)$/;
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
  if (typeof task !== "string" || !TASK_REF.test(task)) throw new Refusal("The task is not a ref like owner/name#123.");
  if (outcome !== "approved" && outcome !== "discarded") throw new Refusal("The outcome is not approved or discarded.");
  if (typeof receipt !== "string" || !RECEIPT.test(receipt)) throw new Refusal("The receipt is not 1 to 100 letters, digits, colons, dots, dashes or underscores.");
  return { action: "close", task, outcome, receipt };
}

export const closeMarker = (receipt: string): string => `<!-- desk:close ${receipt} -->`;

/** The only text the close leaves on the task: the decision and the Desk receipt, never mail content. */
export const closeComment = (outcome: DeskTaskCloseRequest["outcome"], receipt: string): string =>
  `${OUTCOMES[outcome].word} on the Cortex Desk. Desk receipt: ${receipt}.\n\n${closeMarker(receipt)}`;

const repoOf = (map: string): string => {
  const m = TASK_REF.exec(map);
  if (!m?.[1]) throw new Refusal(`"${map}" is not a map ref like owner/name#123.`);
  return m[1];
};

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
  const m = TASK_REF.exec(req.task);
  const repo = m?.[1];
  const num = m?.[2];
  if (!repo || !num) throw new Refusal("The task is not a ref like owner/name#123.");
  if (!opts.maps.map(repoOf).includes(repo)) throw new Refusal(`The task ${req.task} is not on a map this command may close in.`);
  const viewed = await opts.run([opts.gh, "issue", "view", num, "-R", repo, "--json", "state,stateReason,labels,comments,url"]);
  if (viewed.code !== 0) throw new Refusal(`gh could not read ${req.task}: ${lastLine(viewed.stderr) || `exit ${viewed.code}`}`);
  const issue = issueOf(viewed.stdout);
  const url = issue.url && /^https?:/i.test(issue.url) ? { url: issue.url } : {};
  if (!issue.labels.includes(TASK_LABEL)) throw new Refusal(`${req.task} is not a Desk task (no ${TASK_LABEL} label), so it is left open.`);
  if (issue.state.toUpperCase() !== "OPEN") return { id: req.task, ...url, message: `${req.task} was already closed; nothing changed.` };
  const outcome = OUTCOMES[req.outcome];
  if (!issue.comments.some((c) => c.includes(closeMarker(req.receipt)))) {
    const commented = await opts.run([opts.gh, "issue", "comment", num, "-R", repo, "--body", closeComment(req.outcome, req.receipt)]);
    if (commented.code !== 0) throw new Refusal(`gh could not comment on ${req.task}: ${lastLine(commented.stderr) || `exit ${commented.code}`}`);
  }
  const closed = await opts.run([opts.gh, "issue", "close", num, "-R", repo, "--reason", outcome.reason]);
  if (closed.code !== 0) throw new Refusal(`gh could not close ${req.task}: ${lastLine(closed.stderr) || `exit ${closed.code}`}`);
  return { id: req.task, ...url, message: `Closed ${req.task} as ${outcome.said}.` };
}
