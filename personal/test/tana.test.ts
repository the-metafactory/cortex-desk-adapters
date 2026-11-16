import { afterEach, beforeEach, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createdNodeId, DEDUPE_DAYS, ledgerPath, notePayload, noteText, supertagConfigPath, tanaAccess, targetNode, writeNote, type Fetch, type TanaAccess } from "../src/tana";
import { Refusal } from "../../src/writers";

let dir = "";
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "desk-note-tana-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const access = async (): Promise<TanaAccess> => ({ token: "tok-test", endpoint: "https://tana.test/add" });

function fakeFetch(answer: () => Response | Promise<Response>) {
  const calls: { url: string; headers: Record<string, string>; body: unknown }[] = [];
  const fetch: Fetch = async (url, init) => {
    calls.push({ url, headers: init.headers, body: JSON.parse(init.body) });
    return answer();
  };
  return { fetch, calls };
}

const created = (nodeId = "abc123") => () => Response.json({ children: [{ nodeId, name: "x", type: "node" }] });
const opts = (fetch: Fetch, extra: Partial<Parameters<typeof writeNote>[1]> = {}) => ({
  requestId: "req-00000001",
  target: "INBOX",
  access,
  fetch,
  ledgerPath: join(dir, "state", "tana-notes.json"),
  ...extra,
});

it("builds one plain node under the target", () => {
  expect(notePayload("Buy milk", "INBOX")).toEqual({ targetNodeId: "INBOX", nodes: [{ name: "Buy milk" }] });
});

it("checks the note text and the target", () => {
  expect(noteText({ text: "  Buy\n milk  " })).toBe("Buy milk");
  expect(() => noteText({})).toThrow("text is missing");
  expect(() => noteText({ text: "   " })).toThrow("text is missing");
  expect(() => noteText({ text: 7 })).toThrow("must be text");
  expect(() => noteText({ text: "x".repeat(1001) })).toThrow("longer than 1000");
  expect(targetNode("INBOX")).toBe("INBOX");
  expect(targetNode("Ab-c_1")).toBe("Ab-c_1");
  expect(() => targetNode("../x")).toThrow(Refusal);
});

it("reads the created node id from the answer, new or legacy shape", () => {
  expect(createdNodeId({ children: [{ nodeId: "n1" }] })).toBe("n1");
  expect(createdNodeId({ nodeIds: ["n2"] })).toBe("n2");
  expect(createdNodeId({ children: [] })).toBeUndefined();
  expect(createdNodeId("nope")).toBeUndefined();
});

it("posts the note with the token as a bearer header and prints the node", async () => {
  const { fetch, calls } = fakeFetch(created());
  const result = await writeNote({ text: "Call Anna about the offsite" }, opts(fetch));
  expect(calls).toEqual([
    {
      url: "https://tana.test/add",
      headers: { "Content-Type": "application/json", Authorization: "Bearer tok-test" },
      body: { targetNodeId: "INBOX", nodes: [{ name: "Call Anna about the offsite" }] },
    },
  ]);
  expect(result).toEqual({ id: "abc123", url: "https://app.tana.inc/?nodeid=abc123", message: "Added the note to your Tana Inbox." });
});

it("adds nothing on a retry with the same request id", async () => {
  const { fetch, calls } = fakeFetch(created());
  await writeNote({ text: "Once" }, opts(fetch));
  const again = await writeNote({ text: "Once" }, opts(fetch));
  expect(calls).toHaveLength(1);
  expect(again).toEqual({ id: "abc123", url: "https://app.tana.inc/?nodeid=abc123", message: "This note is already in Tana; nothing new was added." });
  await writeNote({ text: "Other" }, opts(fetch, { requestId: "req-00000002" }));
  expect(calls).toHaveLength(2);
});

it("forgets a request id after the dedupe window", async () => {
  const { fetch, calls } = fakeFetch(created());
  const start = Date.UTC(2026, 9, 1);
  await writeNote({ text: "Old" }, opts(fetch, { now: () => start }));
  await writeNote({ text: "Old" }, opts(fetch, { now: () => start + (DEDUPE_DAYS + 1) * 86_400_000 }));
  expect(calls).toHaveLength(2);
});

it("refuses an HTTP error, records nothing, and a retry posts again", async () => {
  const { fetch, calls } = fakeFetch(() => new Response("bad token", { status: 401 }));
  const ledger = join(dir, "state", "tana-notes.json");
  await expect(writeNote({ text: "x" }, opts(fetch))).rejects.toThrow("Tana refused the note with HTTP 401; nothing was created.");
  expect(existsSync(ledger)).toBe(false);
  await expect(writeNote({ text: "x" }, opts(fetch))).rejects.toThrow(Refusal);
  expect(calls).toHaveLength(2);
});

it("says a 5xx may have created the note, and records nothing", async () => {
  const { fetch } = fakeFetch(() => new Response("oops", { status: 503 }));
  await expect(writeNote({ text: "x" }, opts(fetch))).rejects.toThrow("Tana failed with HTTP 503; the note may have been created");
  expect(existsSync(join(dir, "state", "tana-notes.json"))).toBe(false);
});

it("refuses when Tana cannot be reached", async () => {
  const fetch: Fetch = async () => {
    throw new Error("ECONNREFUSED");
  };
  await expect(writeNote({ text: "x" }, opts(fetch))).rejects.toThrow("Tana could not be reached (ECONNREFUSED)");
});

it("refuses a bad payload before any token read or HTTP call", async () => {
  const { fetch, calls } = fakeFetch(created());
  let asked = false;
  const noAccess = async (): Promise<TanaAccess> => {
    asked = true;
    return access();
  };
  await expect(writeNote({ text: "" }, opts(fetch, { access: noAccess }))).rejects.toThrow("text is missing");
  await expect(writeNote({ text: "x" }, opts(fetch, { access: noAccess, target: "a/b" }))).rejects.toThrow(Refusal);
  expect(asked).toBe(false);
  expect(calls).toHaveLength(0);
});

it("keeps the id-less answer as created, without a url", async () => {
  const { fetch } = fakeFetch(() => Response.json({}));
  const result = await writeNote({ text: "x" }, opts(fetch, { target: "nodeAbc" }));
  expect(result).toEqual({ id: "req-00000001", message: "Added the note to Tana." });
  const ledger: unknown = JSON.parse(readFileSync(join(dir, "state", "tana-notes.json"), "utf8"));
  expect(Object.keys(ledger as object)).toEqual(["req-00000001"]);
});

it("reads the token from the environment first, then supertag's config, and refuses without one", async () => {
  const config = join(dir, "config.json");
  await expect(tanaAccess({}, config)).rejects.toThrow("No Tana API token");
  writeFileSync(config, JSON.stringify({ apiToken: "from-file" }));
  expect(await tanaAccess({}, config)).toEqual({ token: "from-file", endpoint: "https://europe-west1-tagr-prod.cloudfunctions.net/addToNodeV2" });
  expect((await tanaAccess({ TANA_API_TOKEN: "from-env" }, config)).token).toBe("from-env");
  writeFileSync(config, JSON.stringify({ apiToken: "t", apiEndpoint: "http://plain.test" }));
  await expect(tanaAccess({}, config)).rejects.toThrow("not an https URL");
  writeFileSync(config, "not json");
  await expect(tanaAccess({}, config)).rejects.toThrow("No Tana API token");
});

it("puts the ledger under the XDG state directory and the config under supertag's", () => {
  expect(ledgerPath({ XDG_STATE_HOME: "/s" })).toBe("/s/cortex-desk-adapters/tana-notes.json");
  expect(supertagConfigPath({ XDG_CONFIG_HOME: "/c" })).toBe("/c/supertag/config.json");
});

it("desk-note-tana exits non-zero with one sentence when no token is found, and posts nothing", () => {
  const bin = join(import.meta.dir, "..", "bin", "desk-note-tana.ts");
  const env = { PATH: process.env.PATH ?? "", HOME: dir, XDG_CONFIG_HOME: join(dir, "cfg"), XDG_STATE_HOME: join(dir, "st") };
  const stdin = JSON.stringify({ kind: "note", fields: { text: "x" }, requestId: "req-00000001" });
  const run = Bun.spawnSync(["bun", bin], { stdin: Buffer.from(stdin), env, timeout: 10_000 });
  const lines = run.stderr.toString().trim().split("\n");
  expect(run.exitCode).toBe(1);
  expect(run.stdout.toString()).toBe("");
  expect(lines).toEqual(["No Tana API token: set TANA_API_TOKEN or run supertag config --token."]);
  expect(existsSync(join(dir, "st"))).toBe(false);
});
