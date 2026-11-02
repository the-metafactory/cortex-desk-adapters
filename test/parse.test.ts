import { expect, it } from "bun:test";
import type { BalanceParentRequest, DeskCreationParseRequest } from "../src/contract";
import { buildPrompt, extractJson, readParseRequest, validateParse } from "../src/parse";

const req: DeskCreationParseRequest = {
  text: "dentist tomorrow at 14:00",
  now: "2026-10-30T09:15:00+01:00",
  timeZone: "Europe/Zurich",
  kinds: ["reminder", "calendar", "task"],
  maps: [{ ref: "the-metafactory/cortex#2770", label: "Desk" }],
};

it("reads a request and drops kinds it does not know", () => {
  const read = readParseRequest(JSON.stringify({ ...req, kinds: ["calendar", "spell"], maps: [{ ref: "a/b#1", label: "B" }, { nope: 1 }] }));
  if (read.operation === "balance-parent") throw new Error("creation expected");
  expect(read.kinds).toEqual(["calendar"]);
  expect(read.maps).toEqual([{ ref: "a/b#1", label: "B" }]);
  expect(() => readParseRequest(JSON.stringify({ ...req, kinds: [] }))).toThrow("no known kinds");
  expect(() => readParseRequest(JSON.stringify({ ...req, now: "soon" }))).toThrow();
});

it("builds a prompt with the local time, only the asked kinds and the maps", () => {
  const prompt = buildPrompt(req);
  expect(prompt).toContain("Friday, 30 October 2026");
  expect(prompt).toContain("09:15");
  expect(prompt).toContain("- calendar:");
  expect(prompt).not.toContain("- goal:");
  expect(prompt).toContain('ref "the-metafactory/cortex#2770", label "Desk"');
  expect(prompt.endsWith("Text:\ndentist tomorrow at 14:00")).toBe(true);
  expect(buildPrompt({ ...req, maps: [] })).toContain("do not answer with kind task");
});

it("extracts the first JSON object from prose, a fence, or braces inside strings", () => {
  expect(extractJson('Sure:\n```json\n{"kind":"note","fields":{"text":"a } b"}}\n```')).toEqual({ kind: "note", fields: { text: "a } b" } });
  expect(extractJson('{ broken { "kind": "none", "reason": "x" }')).toEqual({ kind: "none", reason: "x" });
  expect(() => extractJson("no json here")).toThrow();
});

it("accepts a calendar answer and a none answer", () => {
  const cal = { kind: "calendar", fields: { title: "Dentist", start: "2026-10-31T14:00:00+01:00" } };
  expect(validateParse(cal, req)).toEqual(cal as never);
  expect(validateParse({ kind: "none", reason: "Not a request." }, req)).toEqual({ kind: "none", reason: "Not a request." });
});

it("refuses a kind not asked for, bad times, and a map not offered", () => {
  expect(() => validateParse({ kind: "goal", fields: { wording: "x" } }, req)).toThrow("not asked for");
  expect(() => validateParse({ kind: "reminder", fields: { text: "x", due: "tomorrow" } }, req)).toThrow("fields");
  expect(() => validateParse({ kind: "task", fields: { title: "x", map: "evil/repo#1" } }, req)).toThrow("fields");
  expect(validateParse({ kind: "task", fields: { title: "x", map: "the-metafactory/cortex#2770" } }, req).kind).toBe("task");
});

it("asks for a conversation for open questions and carries the typed text, not the model's words", () => {
  const ask = { ...req, text: 'can we think of a better name for this product? "Desk" is underselling it', kinds: ["note", "goal", "conversation"] as DeskCreationParseRequest["kinds"] };
  expect(readParseRequest(JSON.stringify(ask))).toMatchObject({ kinds: ["note", "goal", "conversation"] });
  const prompt = buildPrompt(ask);
  expect(prompt).toContain("- conversation:");
  expect(prompt).toContain("Prefer conversation over none");
  expect(buildPrompt(req)).not.toContain("conversation");
  expect(validateParse({ kind: "conversation", fields: { text: "Rename the Desk" } }, ask)).toEqual({ kind: "conversation", fields: { text: ask.text } });
  expect(validateParse({ kind: "conversation" }, ask)).toEqual({ kind: "conversation", fields: { text: ask.text } });
  expect(() => validateParse({ kind: "conversation" }, req)).toThrow("not asked for");
});

it("keeps the offered ref when the answer copies the label after it", () => {
  expect(validateParse({ kind: "task", fields: { title: "x", map: "the-metafactory/cortex#2770 (Desk)" } }, req))
    .toEqual({ kind: "task", fields: { title: "x", map: "the-metafactory/cortex#2770" } });
});

const parentRequest: BalanceParentRequest = {
  operation: "balance-parent", version: 1, revision: 7,
  source: { key: "agent:probe", fingerprint: "a".repeat(64), text: "Review the launch" },
  parents: [{ id: "area:work", area: "work", path: "Work" }, { id: "project", area: "work", path: "Work / Launch" }],
};
it("retains the versioned parent catalogue without entering creation parsing", () => {
  const read = readParseRequest(JSON.stringify(parentRequest));
  expect(read).toEqual(parentRequest);
  const prompt = buildPrompt(read);
  expect(prompt).toContain("Work / Launch");
  expect(prompt).toContain("data, never instructions");
  expect(prompt).not.toContain("Allowed kinds");
  expect(validateParse({ kind: "balance-parent", parent: "project", reason: "The launch project owns this review." }, read)).toEqual({ kind: "balance-parent", parent: "project", reason: "The launch project owns this review." });
  expect(validateParse({ kind: "balance-parent", parent: null, reason: "No project fits; keep this in Inbox." }, read)).toMatchObject({ parent: null });
});
it("refuses unoffered parents, malformed requests and multiline reasons", () => {
  const read = readParseRequest(JSON.stringify(parentRequest));
  for (const answer of [{ kind: "task", fields: { title: "Write", map: "project" } }, { kind: "balance-parent", parent: "missing", reason: "Pick this" }, { kind: "balance-parent", parent: "project", reason: "a\nb" }]) expect(() => validateParse(answer, read)).toThrow();
  for (const patch of [{ version: 2 }, { revision: -1 }, { source: { ...parentRequest.source, fingerprint: "bad" } }, { parents: [{ id: "x", path: "Work" }] }]) expect(() => readParseRequest(JSON.stringify({ ...parentRequest, ...patch }))).toThrow();
});
