import { readDeskMessages } from "./desk-messages";
import type { BalanceParentRequest, DeskParseKind, DeskParseRequest, DeskParseResult, ParseInput } from "./contract";
import { isRecord } from "./guards";

const KINDS: DeskParseKind[] = ["reminder", "note", "task", "goal", "calendar", "conversation"];
const isText = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0;
const isIso = (v: unknown): v is string => isText(v) && /^\d{4}-\d{2}-\d{2}/.test(v) && Number.isFinite(Date.parse(v));

/** The parser's stdin, checked; throws on anything Cortex should not have sent. */
export function readParseRequest(text: string): ParseInput {
  const body: unknown = JSON.parse(text);
  const messages = readDeskMessages(body);
  return { ...readRequest(body), messages };
}

function readRequest(body: unknown): DeskParseRequest {
  if (isRecord(body) && body.operation === "balance-parent") return readParentRequest(body);
  if (isRecord(body) && body.operation !== undefined && body.operation !== "create") throw new Error("unsupported parser operation");
  if (!isRecord(body) || !isText(body.text) || !isIso(body.now) || !isText(body.timeZone)) throw new Error("request needs text, now and timeZone");
  const kinds = Array.isArray(body.kinds) ? body.kinds.filter((k): k is DeskParseKind => KINDS.includes(k as DeskParseKind)) : [];
  if (kinds.length === 0) throw new Error("request names no known kinds");
  const maps = Array.isArray(body.maps)
    ? body.maps.filter((m): m is { ref: string; label: string } => isRecord(m) && isText(m.ref) && typeof m.label === "string")
    : [];
  return { text: body.text, now: body.now, timeZone: body.timeZone, kinds, maps };
}

/** The first balanced JSON object in a model's answer, string-aware, so prose or a fence around it does not matter. */
export function extractJson(answer: string): unknown {
  for (let start = answer.indexOf("{"); start !== -1; start = answer.indexOf("{", start + 1)) {
    let depth = 0;
    let inString = false;
    for (let i = start; i < answer.length; i++) {
      const c = answer[i];
      if (inString) {
        if (c === "\\") i++;
        else if (c === '"') inString = false;
      } else if (c === '"') inString = true;
      else if (c === "{") depth++;
      else if (c === "}" && --depth === 0) {
        try {
          return JSON.parse(answer.slice(start, i + 1));
        } catch {
          break;
        }
      }
    }
  }
  throw new Error("no JSON object in the answer");
}

const optText = (v: unknown) => v === undefined || typeof v === "string";

/** Minimal shape check against the request; Cortex validates again, this only stops obvious junk. */
export function validateParse(value: unknown, req: DeskParseRequest): DeskParseResult {
  if (!isRecord(value)) throw new Error("answer is not an object");
  if (req.operation === "balance-parent") {
    if (value.kind !== "balance-parent" || !(value.parent === null || (typeof value.parent === "string" && req.parents.some(p => p.id === value.parent))) || !isText(value.reason) || value.reason.length > 200 || /[\r\n]/.test(value.reason)) throw new Error("invalid Balance parent answer");
    return { kind: "balance-parent", parent: value.parent, reason: value.reason.trim() };
  }
  if (value.kind === "none") {
    if (!isText(value.reason)) throw new Error("none needs a reason");
    return { kind: "none", reason: value.reason };
  }
  const kind = value.kind as DeskParseKind;
  if (!req.kinds.includes(kind)) throw new Error(`kind ${JSON.stringify(value.kind)} was not asked for`);
  if (kind === "conversation") return { kind, fields: { text: req.text } };
  const f = value.fields;
  if (!isRecord(f)) throw new Error("answer has no fields");
  // A model sometimes copies the label after the ref ("owner/name#1 (Desk)"); keep the offered ref.
  if (kind === "task" && typeof f.map === "string") f.map = req.maps.find((m) => f.map === m.ref || (f.map as string).startsWith(`${m.ref} `))?.ref ?? f.map;
  const ok = (() => {
    switch (kind) {
      case "reminder": return isText(f.text) && isIso(f.due);
      case "note": return isText(f.text);
      case "goal": return isText(f.wording) && !/[\r\n]/.test(f.wording);
      case "task": return isText(f.title) && optText(f.details) && req.maps.some((m) => m.ref === f.map);
      case "calendar":
        return isText(f.title) && isIso(f.start) && (f.end === undefined || isIso(f.end)) && (f.allDay === undefined || typeof f.allDay === "boolean")
          && optText(f.location) && optText(f.notes);
    }
  })();
  if (!ok) throw new Error(`fields do not fit kind ${kind}`);
  return { kind, fields: f } as DeskParseResult;
}

function readParentRequest(body: Record<string, unknown>): BalanceParentRequest {
  if (body.version !== 1 || typeof body.revision !== "number" || !Number.isSafeInteger(body.revision) || body.revision < 0 || !isRecord(body.source) || !isText(body.source.key) || !isText(body.source.text) || body.source.text.length > 4000 || typeof body.source.fingerprint !== "string" || !/^[a-f0-9]{64}$/.test(body.source.fingerprint) || !Array.isArray(body.parents) || body.parents.length > 500) throw new Error("invalid Balance parent request");
  const parents: BalanceParentRequest["parents"] = [];
  for (const parent of body.parents) {
    if (!isRecord(parent) || !isText(parent.id) || !isText(parent.area) || !isText(parent.path) || parent.path.length > 2000 || parents.some(p => p.id === parent.id)) throw new Error("invalid Balance parent catalogue");
    parents.push({ id: parent.id, area: parent.area, path: parent.path });
  }
  return { operation: "balance-parent", version: 1, revision: body.revision, source: { key: body.source.key, fingerprint: body.source.fingerprint, text: body.source.text }, parents };
}
