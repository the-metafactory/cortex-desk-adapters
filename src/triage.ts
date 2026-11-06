import { isRecord } from "./guards";

export const CATEGORIES = ["action", "reply", "meeting", "fyi", "bulk"] as const;
export const SUGGESTED_ACTIONS = ["reply", "archive", "link-meeting", "task", "none"] as const;
export const PREDICTED_ACTIONS = ["archive", "junk", "trash", "reply", "plan", "todo", "keep"] as const;
export const EVIDENCE_KINDS = ["mail", "event", "note"] as const;
export const MAX_REASON = 200;
export const MAX_SUMMARY = 600;
export const MAX_EVIDENCE = 5;
export const MAX_REF = 300;
export const MAX_TITLE = 200;
const MAX_CORRECTIONS = 10;
const MAX_EXAMPLES = 10;

export type Category = (typeof CATEGORIES)[number];
export type SuggestedAction = (typeof SUGGESTED_ACTIONS)[number];
export type PredictedAction = (typeof PREDICTED_ACTIONS)[number];

export interface TriageExample {
  category?: string;
  subject: string;
  summary: string;
  sender: string;
  action: string;
  decidedAt: string;
  similarity: number;
  weight: number;
}

export interface TriageMail {
  id: string;
  sourceId?: string;
  from: { name?: string; address: string };
  subject: string;
  firstParagraph: string;
  receivedAt: string;
  account?: string;
}

export interface TriageRequest {
  sourcePolicy?: "cloud" | "local";
  notes?: { id: string; name: string; text: string; areas?: string[]; sourcePolicy?: string }[];
  mail: TriageMail;
  meetings: { key: string; title: string; start: string; sourceId?: string; sourcePolicy?: string }[];
  vips: string[];
  unimportant: string[];
  corrections: { kind: string; source: string; mode: string; label: string }[];
  examples: TriageExample[];
  examplesBasis: string;
}

export interface TriageEvidence {
  kind: (typeof EVIDENCE_KINDS)[number];
  ref: string;
  title: string;
}

export interface TriageAnswer {
  category: Category;
  commitment?: "request" | "invitation" | "none" | "unknown";
  meetingKey?: string;
  reason: string;
  summary?: string;
  suggestedAction?: SuggestedAction;
  predictedAction?: PredictedAction;
  suspicious?: boolean;
  evidence?: TriageEvidence[];
}

const str = (v: unknown, field: string): string => {
  if (typeof v !== "string") throw new Error(`the request's ${field} is not text`);
  return v;
};
const strings = (v: unknown, field: string): string[] => {
  if (v === undefined) return [];
  if (!Array.isArray(v)) throw new Error(`the request's ${field} is not a list`);
  return v.map((x, i) => str(x, `${field}[${i}]`));
};
const num = (v: unknown, field: string): number => {
  if (typeof v !== "number" || !Number.isFinite(v)) throw new Error(`the request's ${field} is not a number`);
  return v;
};
const records = (v: unknown, field: string): Record<string, unknown>[] => {
  if (v === undefined) return [];
  if (!Array.isArray(v) || !v.every(isRecord)) throw new Error(`the request's ${field} is not a list of objects`);
  return v;
};

function readExample(x: Record<string, unknown>, i: number): TriageExample {
  const at = (field: string): string => `examples[${i}].${field}`;
  return {
    subject: str(x.subject, at("subject")), summary: str(x.summary, at("summary")), sender: str(x.sender, at("sender")),
    action: str(x.action, at("action")), decidedAt: str(x.decidedAt, at("decidedAt")),
    similarity: num(x.similarity, at("similarity")), weight: num(x.weight, at("weight")),
    ...(typeof x.category === "string" && x.category ? { category: x.category } : {}),
  };
}

export function readTriageRequest(text: string): TriageRequest {
  const body: unknown = JSON.parse(text);
  if (!isRecord(body) || !isRecord(body.mail) || !isRecord(body.mail.from)) throw new Error("the request has no mail");
  const m = body.mail;
  const from = m.from as Record<string, unknown>;
  const mail: TriageMail = {
    id: str(m.id, "mail.id"),
    ...(typeof m.sourceId === "string" ? { sourceId: m.sourceId } : {}),
    from: { address: str(from.address, "mail.from.address"), ...(typeof from.name === "string" ? { name: from.name } : {}) },
    subject: str(m.subject, "mail.subject"),
    firstParagraph: typeof m.firstParagraph === "string" ? m.firstParagraph : "",
    receivedAt: str(m.receivedAt, "mail.receivedAt"),
    ...(typeof m.account === "string" && m.account ? { account: m.account } : {}),
  };
  return {
    mail,
    ...(body.sourcePolicy === "cloud" || body.sourcePolicy === "local" ? { sourcePolicy: body.sourcePolicy } : {}),
    notes: records(body.notes, "notes").slice(0, 30).map((x, i) => ({ id: str(x.id, `notes[${i}].id`), name: str(x.name, `notes[${i}].name`), areas: strings(x.areas, `notes[${i}].areas`), sourcePolicy: typeof x.sourcePolicy === "string" ? x.sourcePolicy : "", text: str(x.text, `notes[${i}].text`).slice(0, 600) })),
    meetings: records(body.meetings, "meetings").map((x, i) => ({ key: str(x.key, `meetings[${i}].key`), title: str(x.title, `meetings[${i}].title`), start: str(x.start, `meetings[${i}].start`), sourceId: typeof x.sourceId === "string" ? x.sourceId : "", sourcePolicy: typeof x.sourcePolicy === "string" ? x.sourcePolicy : "" })),
    vips: strings(body.vips, "vips"),
    unimportant: strings(body.unimportant, "unimportant"),
    corrections: records(body.corrections, "corrections").slice(0, MAX_CORRECTIONS).map((x, i) => ({
      kind: str(x.kind, `corrections[${i}].kind`), source: str(x.source, `corrections[${i}].source`), mode: str(x.mode, `corrections[${i}].mode`), label: str(x.label, `corrections[${i}].label`),
    })),
    examples: records(body.examples, "examples").slice(0, MAX_EXAMPLES).map(readExample),
    examplesBasis: typeof body.examplesBasis === "string" ? body.examplesBasis : "",
  };
}

const listed = (list: readonly string[], address: string): boolean => {
  const a = address.trim().toLowerCase();
  const domain = a.slice(a.lastIndexOf("@"));
  return list.some((entry) => {
    const e = entry.trim().toLowerCase();
    return e === a || (e.startsWith("@") && e === domain);
  });
};

export function isUnimportantSender(req: TriageRequest): boolean {
  return listed(req.unimportant, req.mail.from.address) && !listed(req.vips, req.mail.from.address);
}

export const UNIMPORTANT_REASON = "You marked mail from this sender unimportant.";

const CORRECTION_TEXT: Record<string, string> = {
  less: "asked to see less of",
  always: "asked to always see",
};

export function renderCorrections(req: TriageRequest): string {
  if (req.corrections.length === 0) return "None yet.";
  return req.corrections.map((c) => `- The person ${CORRECTION_TEXT[c.mode] ?? `marked (${c.mode})`}: ${c.label}.`).join("\n");
}

const BASIS_TEXT: Record<string, string> = {
  content: "found by content similarity",
  sender: "found by the same sender domain or mailing list, not by content",
};

function renderExample(e: TriageExample): string {
  const correction = e.weight > 1 ? " (correction, weight 2)" : "";
  const sorted = e.category ? `, sorted as ${e.category}` : "";
  return `- ${e.action}${correction}, similarity ${e.similarity}: "${e.subject}" from ${e.sender}, ${e.decidedAt}${sorted}. ${e.summary}`.trim();
}

export function renderExamples(req: TriageRequest): string {
  if (req.examples.length === 0) return "None yet.";
  const basis = BASIS_TEXT[req.examplesBasis];
  const head = `(${basis ? `${basis}; ` : ""}weight 2 marks a correction the person made)`;
  return [head, ...req.examples.map(renderExample)].join("\n");
}

export interface Prepared {
  triage_answer: TriageAnswer | null;
  triage_queue: { mail: string; meetings: string; senders: string; corrections: string; examples: string; account: string }[];
}

export function prepare(req: TriageRequest): Prepared {
  if (isUnimportantSender(req)) return { triage_answer: { category: "bulk", commitment: "none", reason: UNIMPORTANT_REASON, suggestedAction: "archive" }, triage_queue: [] };
  return {
    triage_answer: null,
    triage_queue: [{
      mail: JSON.stringify(req.mail, null, 2),
      meetings: req.meetings.length > 0 ? req.meetings.map((m) => `- ${m.key}: ${m.title} (${m.start})`).join("\n") : "None.",
      senders: JSON.stringify({ vips: req.vips, unimportant: req.unimportant }),
      corrections: renderCorrections(req),
      examples: renderExamples(req),
      account: req.mail.account ?? "unknown",
    }],
  };
}

export function parseAnswerText(text: string): unknown {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("the model answered without a JSON object");
  return JSON.parse(text.slice(start, end + 1));
}

const ANSWER_KEYS = new Set(["commitment", "category", "meetingKey", "reason", "summary", "suggestedAction", "predictedAction", "suspicious", "evidence"]);
const EVIDENCE_KEYS = new Set(["kind", "ref", "title"]);

const extraKey = (o: Record<string, unknown>, allowed: Set<string>): string | undefined => Object.keys(o).find((k) => !allowed.has(k));
const oneOf = <T extends string>(list: readonly T[], v: unknown): v is T => typeof v === "string" && (list as readonly string[]).includes(v);
const text = (v: unknown, field: string, max: number): string => {
  if (typeof v !== "string" || v.trim().length === 0) throw new Error(`the answer's ${field} is missing or not text`);
  const t = v.trim();
  if (t.length > max) throw new Error(`the answer's ${field} is longer than ${max} characters`);
  return t;
};
const absent = (v: unknown): boolean => v === undefined || v === null || v === "";

export function validateTriage(answer: unknown, meetingKeys: ReadonlySet<string>): TriageAnswer {
  if (!isRecord(answer)) throw new Error("the answer is not a JSON object");
  const extra = extraKey(answer, ANSWER_KEYS);
  if (extra) throw new Error(`the answer has an unknown field: ${extra}`);
  if (!oneOf(CATEGORIES, answer.category)) throw new Error("the answer's category is not one the Desk knows");
  const category = answer.category;
  const out: TriageAnswer = { category, reason: text(answer.reason, "reason", MAX_REASON) };
  if (answer.commitment !== undefined) {
    if (!oneOf(["request", "invitation", "none", "unknown"] as const, answer.commitment)) throw new Error("the answer has an invalid commitment marker");
    out.commitment = answer.commitment;
  }
  if (!absent(answer.meetingKey)) {
    const key = text(answer.meetingKey, "meetingKey", MAX_REF);
    if (!meetingKeys.has(key)) throw new Error("the answer names a meeting the request did not list");
    if (category !== "bulk") out.meetingKey = key;
  }
  if (!absent(answer.summary)) out.summary = text(answer.summary, "summary", MAX_SUMMARY);
  if (!absent(answer.suggestedAction)) {
    if (!oneOf(SUGGESTED_ACTIONS, answer.suggestedAction)) throw new Error("the answer's suggestedAction is not one the Desk knows");
    out.suggestedAction = answer.suggestedAction;
  }
  if (!absent(answer.predictedAction)) {
    if (!oneOf(PREDICTED_ACTIONS, answer.predictedAction)) throw new Error("the answer's predictedAction is not one the Desk knows");
    out.predictedAction = answer.predictedAction;
  }
  if (!absent(answer.suspicious)) {
    if (typeof answer.suspicious !== "boolean") throw new Error("the answer's suspicious marker is not true or false");
    if (answer.suspicious) out.suspicious = true;
  }
  if (!absent(answer.evidence)) {
    if (!Array.isArray(answer.evidence)) throw new Error("the answer's evidence is not a list");
    if (answer.evidence.length > MAX_EVIDENCE) throw new Error(`the answer has more than ${MAX_EVIDENCE} pieces of evidence`);
    const evidence = answer.evidence.map((e: unknown, i): TriageEvidence => {
      if (!isRecord(e)) throw new Error(`evidence ${i} is not an object`);
      const bad = extraKey(e, EVIDENCE_KEYS);
      if (bad) throw new Error(`evidence ${i} has an unknown field: ${bad}`);
      if (!oneOf(EVIDENCE_KINDS, e.kind)) throw new Error(`evidence ${i} has an unknown kind`);
      return { kind: e.kind, ref: text(e.ref, `evidence ${i} ref`, MAX_REF), title: text(e.title, `evidence ${i} title`, MAX_TITLE) };
    });
    if (evidence.length > 0) out.evidence = evidence;
  }
  return out;
}

export function checkFlowOutput(payload: Record<string, unknown>): TriageAnswer {
  const request = payload.request as TriageRequest;
  const keys = new Set(request.meetings.map((m) => m.key));
  const short = payload.triage_answer;
  if (isRecord(short)) return validateTriage(short, keys);
  const researched = payload.triage_researched;
  const first = Array.isArray(researched) && isRecord(researched[0]) ? researched[0] : null;
  const raw = first?.triage_text;
  if (typeof raw !== "string" || raw.trim().length === 0) throw new Error("the research step wrote no answer");
  return validateTriage(parseAnswerText(raw), keys);
}
