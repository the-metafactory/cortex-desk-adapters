import { MAIL_CATEGORIES, PREDICTED_ACTIONS, SUGGESTED_ACTIONS } from "@the-metafactory/cortex/desk-sdk";
import { readDeskMessages, type DeskMessages } from "../../src/desk-messages";
import { isRecord } from "../../src/guards";

export const EVIDENCE_KINDS = ["mail", "event", "note"] as const;
export const MAX_REASON = 200;
export const MAX_SUMMARY = 600;
export const MAX_EVIDENCE = 5;
export const MAX_REF = 300;
export const MAX_TITLE = 200;

export type Category = (typeof MAIL_CATEGORIES)[number];
export type SuggestedAction = (typeof SUGGESTED_ACTIONS)[number];
export type PredictedAction = (typeof PREDICTED_ACTIONS)[number];

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
  messages: DeskMessages;
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
  deadline?: string;
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
const records = (v: unknown, field: string): Record<string, unknown>[] => {
  if (v === undefined) return [];
  if (!Array.isArray(v) || !v.every(isRecord)) throw new Error(`the request's ${field} is not a list of objects`);
  return v;
};

export function readTriageRequest(text: string): TriageRequest {
  const body: unknown = JSON.parse(text);
  if (!isRecord(body) || !isRecord(body.mail) || !isRecord(body.mail.from)) throw new Error("the request has no mail");
  const messages = readDeskMessages(body);
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
    messages,
  };
}

export function parseAnswerText(text: string): unknown {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("the model answered without a JSON object");
  return JSON.parse(text.slice(start, end + 1));
}

const ANSWER_KEYS = new Set(["commitment", "category", "meetingKey", "reason", "summary", "suggestedAction", "predictedAction", "suspicious", "deadline", "evidence"]);
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
  if (!oneOf(MAIL_CATEGORIES, answer.category)) throw new Error("the answer's category is not one the Desk knows");
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
  if (!absent(answer.deadline)) out.deadline = text(answer.deadline, "deadline", MAX_REF);
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
  const raw = payload.triage_text;
  if (typeof raw !== "string" || raw.trim().length === 0) throw new Error("the research step wrote no answer");
  return validateTriage(parseAnswerText(raw), keys);
}
