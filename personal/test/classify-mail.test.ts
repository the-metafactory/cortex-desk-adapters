import { afterAll, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyMail, TriageUnavailable } from "../src/classify-mail";
import { asPulseApi, pulse, type ChatModel } from "../src/pulse";
import { readTriageRequest, validateTriage, type TriageRequest } from "../src/triage";

const ROOT = join(import.meta.dir, "..");
const FLOW = join(ROOT, "flows", "desk-mail-triage.yaml");
const ACTIONS = join(import.meta.dir, "fixtures", "actions");
const KEY = "cal:work-calendar:k1";

const dirs: string[] = [];
const scratch = async (): Promise<string> => {
  const d = await mkdtemp(join(tmpdir(), "desk-classify-"));
  dirs.push(d);
  return d;
};
afterAll(async () => { await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true }))); });

const request = (): TriageRequest => ({
  mail: { id: "m1@example.org", from: { name: "Ada", address: "ada@example.org" }, subject: "Agenda for Monday", firstParagraph: "Here is what I want to cover.", receivedAt: "2026-10-31T08:00:00Z", account: "work" },
  meetings: [{ key: KEY, title: "Planning meeting", start: "2026-11-02T14:00:00Z" }],
  messages: { system: "Cortex classifies mail.", user: JSON.stringify({ mail: { subject: "Agenda for Monday", account: "work" }, meetings: [{ key: KEY }] }) },
});

const wireRequest = () => {
  const { messages, ...rest } = request();
  return { ...rest, messages: [{ role: "system", content: messages.system }, { role: "user", content: messages.user }] };
};

type Reply = { content: string | null; toolCalls: { id: string; type: "function"; function: { name: string; arguments: string } }[] };
const say = (content: string): Reply => ({ content, toolCalls: [] });
const call = (name: string, args: Record<string, unknown>): Reply => ({ content: null, toolCalls: [{ id: `c-${name}`, type: "function", function: { name, arguments: JSON.stringify(args) } }] });

function stubModel(replies: (Reply | Error)[]): ChatModel & { requests: unknown[] } {
  const requests: unknown[] = [];
  return {
    label: "stub",
    requests,
    complete(req: unknown) {
      requests.push(req);
      const next = replies.shift() ?? say("");
      return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
    },
  };
}

const run = async (req: TriageRequest, model: ChatModel, flow = FLOW) => {
  const state = await scratch();
  const transcripts = join(state, "transcripts");
  return { transcripts, result: await classifyMail(req, { flow, model, actionDirs: [ACTIONS], transcriptDir: transcripts }) };
};

const VALID = JSON.stringify({ commitment: "invitation",
  category: "meeting", meetingKey: KEY, reason: "Ada sends the agenda for the Kundenmeeting.", summary: "Ada lists the topics for Monday's meeting.",
  suggestedAction: "link-meeting", predictedAction: "reply", evidence: [{ kind: "event", ref: KEY, title: "Planning meeting" }, { kind: "mail", ref: "<prev@example.org>", title: "Re: Kundenmeeting agenda" }],
});

describe("the triage flow", () => {
  it("researches with the tools and prints a valid answer", async () => {
    const model = stubModel([call("A_CALENDAR_EVENTS", { query: "Ada" }), call("A_MAIL_SEARCH", { account: "work", from: "ada@example.org" }), say(`Here you go:\n${VALID}`)]);
    const { result, transcripts } = await run(request(), model);
    expect(result.answer).toEqual(validateTriage(JSON.parse(VALID), new Set([KEY])));
    expect(result).toMatchObject({ rounds: 2, toolCalls: 2 });
    const first = JSON.stringify(model.requests[0]);
    expect(first).toContain(KEY);
    expect(first).toContain("A_NOTES_SEARCH");
    expect(result.answer.commitment).toBe("invitation");
    expect(result.answer.predictedAction).toBe("reply");
    expect(((await stat(transcripts)).mode & 0o777).toString(8)).toBe("700");
    expect((await readdir(transcripts)).some((f) => f.endsWith(".jsonl"))).toBe(true);
  });

  it("fails on an answer the Desk does not accept", async () => {
    const bad = [
      { category: "spam", reason: "x" },
      { category: "meeting", meetingKey: "cal:other:9", reason: "x" },
      { category: "fyi", reason: "x".repeat(201) },
      { category: "fyi", reason: "x", summary: "y".repeat(601) },
      { category: "fyi", reason: "x", suggestedAction: "forward" },
      { category: "fyi", reason: "x", predictedAction: "forward" },
      { category: "fyi", reason: "x", mood: "happy" },
      { category: "fyi", reason: "x", evidence: Array.from({ length: 6 }, () => ({ kind: "mail", ref: "r", title: "t" })) },
      { category: "fyi", reason: "x", evidence: [{ kind: "mail", ref: "r", title: "t", url: "https://x" }] },
    ];
    for (const answer of bad) {
      await expect(run(request(), stubModel([say(JSON.stringify(answer))]))).rejects.toThrow("A_DESK_TRIAGE_CHECK");
    }
    await expect(run(request(), stubModel([say("I think it is a meeting.")]))).rejects.toThrow("without a JSON object");
  });

  it("reports an unreachable model as unavailable", async () => {
    const down = new pulse.ModelUnavailableError("stub", "network error", { unreachable: true });
    await expect(run(request(), stubModel([down]))).rejects.toBeInstanceOf(TriageUnavailable);
  });

  it("gives up when the research outlives its timeout", async () => {
    const state = await scratch();
    const flow = join(state, "short.yaml");
    await Bun.write(flow, (await Bun.file(FLOW).text()).replace("timeout_ms: 60000", "timeout_ms: 200"));
    await Promise.all(["A_DESK_TRIAGE_CHECK"].map(async (a) => {
      for (const f of ["action.json", "action.ts"]) await Bun.write(join(state, a, f), (await Bun.file(join(ROOT, "flows", a, f)).text()).replace("../../src/", `${ROOT}/src/`));
    }));
    const hang: ChatModel = { label: "stub", complete: (_r, o) => new Promise((_, reject) => o?.signal?.addEventListener("abort", () => reject(new Error("aborted")))) };
    const started = Date.now();
    await expect(classifyMail(request(), { flow, model: hang, actionDirs: [ACTIONS], transcriptDir: join(state, "t") })).rejects.toBeInstanceOf(TriageUnavailable);
    expect(Date.now() - started).toBeLessThan(5000);
  });
});

describe("the request", () => {
  it("reads the Desk's stdin and refuses one without a mail", () => {
    expect(readTriageRequest(JSON.stringify(wireRequest())).mail.account).toBe("work");
    expect(() => readTriageRequest(JSON.stringify({ meetings: [] }))).toThrow("no mail");
  });
});

describe("the command", () => {
  it("exits non-zero with one line and no stdout when the gateway is unreachable", async () => {
    const state = await scratch();
    const proc = Bun.spawn([join(ROOT, "bin", "desk-classify-mail.ts"), "--flow", FLOW, "--base-url", "http://127.0.0.1:9/v1", "--model", "m", "--actions-dir", ACTIONS, "--state-dir", state], {
      stdin: new Blob([JSON.stringify(wireRequest())]), stdout: "pipe", stderr: "pipe", env: { ...process.env, DESK_CLASSIFIER_KEY: "k" },
    });
    const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    expect(code).not.toBe(0);
    expect(out).toBe("");
    expect(err.trim().split("\n")).toHaveLength(1);
    expect(err).toContain("the model is unavailable");
  });
});

describe("the pulse boundary", () => {
  it("names what a pulse version without the expected exports lacks", () => {
    expect(() => asPulseApi({ runPipelineFromYaml: () => null })).toThrow("pulse lacks OpenAICompatibleChatModel, ResearchUnavailable, MapItemFailure, ModelUnavailableError");
  });
});

describe("the transcript dir", () => {
  it("tightens a dir that already exists to 0700", async () => {
    const dir = join(await scratch(), "transcripts");
    await mkdir(dir, { mode: 0o755 });
    await classifyMail(request(), { flow: FLOW, model: stubModel([say(VALID)]), actionDirs: [ACTIONS], transcriptDir: dir });
    expect(((await stat(dir)).mode & 0o777).toString(8)).toBe("700");
  });
});


it("validates explicit commitment independently of ranking, rejects unknown values, preserves missing as unassessed", () => {
  for (const commitment of ["request", "invitation", "none", "unknown"] as const) {
    expect(validateTriage({ category: "reply", commitment, reason: "Evidence" }, new Set()).commitment).toBe(commitment);
  }
  expect(() => validateTriage({ category: "reply", commitment: "yes", reason: "Evidence" }, new Set())).toThrow("invalid commitment");
  expect(validateTriage({ category: "meeting", reason: "Existing meeting" }, new Set()).commitment).toBeUndefined();
});

describe("the suspicious marker", () => {
  it("is kept when true, dropped when false, and refused when not a boolean", () => {
    expect(validateTriage({ category: "fyi", reason: "Looks off.", suspicious: true }, new Set()).suspicious).toBe(true);
    expect(validateTriage({ category: "fyi", reason: "Fine.", suspicious: false }, new Set())).toEqual({ category: "fyi", reason: "Fine." });
    expect(() => validateTriage({ category: "fyi", reason: "r", suspicious: "yes" }, new Set())).toThrow("the answer's suspicious marker is not true or false");
  });
});
