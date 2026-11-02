import { expect, it } from "bun:test";
import type { Runner } from "../src/run";
import { closeComment, closeMarker, closeTask, parseRef, readCloseRequest } from "../src/task-close";
import { Refusal } from "../src/writers";

type Answer = { code?: number; stdout?: string; stderr?: string };

function gh(issue: Record<string, unknown>, fail?: { on: string; answer: Answer }) {
  const calls: string[][] = [];
  const run: Runner = async (argv) => {
    calls.push(argv);
    if (fail && argv[2] === fail.on) return { code: fail.answer.code ?? 1, stdout: fail.answer.stdout ?? "", stderr: fail.answer.stderr ?? "" };
    if (argv[2] === "view") return { code: 0, stdout: JSON.stringify(issue), stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  };
  return { run, calls };
}

const open = { state: "OPEN", url: "https://github.com/jcfischer/desk/issues/7", labels: [{ name: "desk:principal-intake" }], comments: [] };
const maps = ["jcfischer/desk#1"];
const approved = { action: "close", task: "jcfischer/desk#7", outcome: "approved", receipt: "ivy:handoff-0001" } as const;

it("closes an approved task as completed with one comment that names only the decision and the receipt", async () => {
  const fake = gh(open);
  const result = await closeTask(approved, { gh: "gh", run: fake.run, maps });
  expect(result).toEqual({ id: "jcfischer/desk#7", url: "https://github.com/jcfischer/desk/issues/7", message: "Closed jcfischer/desk#7 as done." });
  expect(fake.calls.map((c) => c[2])).toEqual(["view", "comment", "close"]);
  expect(fake.calls[1]).toEqual(["gh", "issue", "comment", "7", "-R", "jcfischer/desk", "--body", "Approved on the Cortex Desk. Desk receipt: ivy:handoff-0001.\n\n<!-- desk:close ivy:handoff-0001 -->"]);
  expect(fake.calls[2]).toEqual(["gh", "issue", "close", "7", "-R", "jcfischer/desk", "--reason", "completed"]);
});

it("closes a discarded task as not planned", async () => {
  const fake = gh(open);
  const result = await closeTask({ ...approved, outcome: "discarded" }, { gh: "gh", run: fake.run, maps });
  expect(result.message).toBe("Closed jcfischer/desk#7 as not planned.");
  expect(fake.calls[1]?.at(-1)).toStartWith("Discarded on the Cortex Desk.");
  expect(fake.calls[2]?.slice(-2)).toEqual(["--reason", "not planned"]);
});

it("posts no second comment when a retry finds its own marker, and leaves a closed task alone", async () => {
  const commented = gh({ ...open, comments: [{ body: closeComment("approved", "ivy:handoff-0001") }] });
  await closeTask(approved, { gh: "gh", run: commented.run, maps });
  expect(commented.calls.map((c) => c[2])).toEqual(["view", "close"]);
  const closed = gh({ ...open, state: "CLOSED", stateReason: "NOT_PLANNED" });
  expect((await closeTask(approved, { gh: "gh", run: closed.run, maps })).message).toBe("jcfischer/desk#7 was already closed; nothing changed.");
  expect(closed.calls.map((c) => c[2])).toEqual(["view"]);
});

it("refuses a task in another repo, an unlabelled issue, and no --map, without changing anything", async () => {
  const other = gh(open);
  await expect(closeTask({ ...approved, task: "the-metafactory/cortex#7" }, { gh: "gh", run: other.run, maps })).rejects.toThrow("not on a map");
  expect(other.calls).toEqual([]);
  const plain = gh({ ...open, labels: [] });
  await expect(closeTask(approved, { gh: "gh", run: plain.run, maps })).rejects.toThrow("not a Desk task");
  expect(plain.calls.map((c) => c[2])).toEqual(["view"]);
  await expect(closeTask(approved, { gh: "gh", run: gh(open).run, maps: [] })).rejects.toThrow("may close nothing");
});

it("reports a failed close as a refusal sentence", async () => {
  const fake = gh(open, { on: "close", answer: { stderr: "HTTP 502\nGraphQL: Something went wrong" } });
  await expect(closeTask(approved, { gh: "gh", run: fake.run, maps })).rejects.toThrow("gh could not close jcfischer/desk#7: GraphQL: Something went wrong");
});

it("closes in a map given as a qualified ref, and compares repos without case", async () => {
  const fake = gh(open);
  await closeTask({ ...approved, task: "jcfischer/Desk#7" }, { gh: "gh", run: fake.run, maps: ["github:github.com/jcfischer/desk#1"] });
  expect(fake.calls[0]?.slice(0, 6)).toEqual(["gh", "issue", "view", "7", "-R", "jcfischer/Desk"]);
  const ghe = gh(open);
  await closeTask({ ...approved, task: "github:git.example.org/team/desk#7" }, { gh: "gh", run: ghe.run, maps: ["github:git.example.org/team/desk#1"] });
  expect(ghe.calls[0]?.slice(4, 6)).toEqual(["-R", "git.example.org/team/desk"]);
  expect(parseRef("desk#7")).toBeNull();
});

it("reads only a well-formed close request", () => {
  expect(readCloseRequest(JSON.stringify(approved))).toEqual(approved);
  expect(() => readCloseRequest("nope")).toThrow(Refusal);
  expect(() => readCloseRequest(JSON.stringify({ ...approved, action: "reopen" }))).toThrow("only closes");
  expect(() => readCloseRequest(JSON.stringify({ ...approved, task: "desk#7" }))).toThrow("not a ref");
  expect(() => readCloseRequest(JSON.stringify({ ...approved, outcome: "done" }))).toThrow("outcome");
  expect(() => readCloseRequest(JSON.stringify({ ...approved, receipt: "a b" }))).toThrow("receipt");
  expect(closeMarker("ivy:x")).toBe("<!-- desk:close ivy:x -->");
});
