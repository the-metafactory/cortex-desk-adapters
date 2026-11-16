import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DeskSourceMail, DeskSourceSentMail } from "../src/cortex-contract";
import { readItems, readSentItems, type ReadBox, type ReadMessage, type ReadQuery } from "../src/imap";
import { fixtureMessages, SELF, toFetched, type FixtureMessage } from "./fixtures/imap-sent-data";

const HOUR = 3_600_000;
const NOW = Date.parse("2026-11-02T12:00:00Z");

interface Open {
  path: string;
  readOnly: boolean;
}

interface Fetch {
  folder: string;
  headers?: string[];
}

/** A fixture mailbox over the read-box seam: every search, fetch and body read happens inside `inFolder`. */
function fixtureBox(options: { duplicateSent?: boolean; failSent?: boolean } = {}): { box: ReadBox; reads: string[]; outside: string[]; opens: Open[]; fetches: Fetch[] } {
  const messages = fixtureMessages(NOW);
  const folders: Record<string, FixtureMessage[]> = {
    INBOX: messages.INBOX,
    Sent: messages.Sent,
    ...(options.duplicateSent ? { "Sent Items": messages["Sent Items"] } : {}),
    Archive: messages.Archive,
  };
  const reads: string[] = [];
  const outside: string[] = [];
  const opens: Open[] = [];
  const fetches: Fetch[] = [];
  let open = "";
  const current = (): FixtureMessage[] => folders[open] ?? [];
  const inside = (what: string): void => { if (!open) outside.push(what); };
  const box: ReadBox = {
    folders: async () => [
      { path: "INBOX", name: "INBOX", specialUse: "\\Inbox" },
      { path: "Sent", name: "Sent", specialUse: "\\Sent" },
      ...(options.duplicateSent ? [{ path: "Sent Items", name: "Sent Items" }] : []),
      { path: "Archive", name: "Archive", specialUse: "\\Archive" },
    ],
    inFolder: async (path, work) => {
      // The fixture's only read path is the read-only one (EXAMINE).
      if (path === "Sent" && options.failSent) throw new Error("the Sent folder is unavailable");
      opens.push({ path, readOnly: true });
      const before = open;
      open = path;
      try {
        return await work();
      } finally {
        open = before;
      }
    },
    search: async (query, max) => {
      inside("search");
      return current()
        .filter((f) => ("unseen" in query ? !f.seen : f.date >= query.since))
        .map((f) => f.uid)
        .sort((a, b) => b - a)
        .slice(0, max);
    },
    fetch: async (uids: number[], query: ReadQuery): Promise<ReadMessage[]> => {
      inside("fetch");
      fetches.push({ folder: open, ...(query.headers ? { headers: query.headers } : {}) });
      return current()
        .filter((f) => uids.includes(f.uid))
        .map((f) => toFetched(f, query));
    },
    text: async (uid) => {
      inside("text");
      reads.push(`${open}:${uid}`);
      return current().find((f) => f.uid === uid)?.body ?? "";
    },
  };
  return { box, reads, outside, opens, fetches };
}

const readAll = (box: ReadBox, warn?: (line: string) => void): Promise<DeskSourceMail[]> =>
  readItems(box, { account: "personal", mailbox: "INBOX", limit: 30, self: SELF, invite: { days: 14, scan: 200, limit: 10 }, now: NOW, ...(warn ? { warn } : {}) });

const readNewestSent = (box: ReadBox, overrides: { days?: number; limit?: number; warn?: (line: string) => void } = {}): Promise<DeskSourceSentMail[]> =>
  readSentItems(box, { account: "personal", days: 14, limit: 40, now: NOW, ...overrides });

describe("desk-imap --sent", () => {
  test("lists the newest sent mail with its replies and thread references", async () => {
    const { box, reads, outside, opens, fetches } = fixtureBox({ duplicateSent: true });
    const sent = await readNewestSent(box);

    expect(sent.map((s) => s.id)).toEqual(["quote@example.org", "second@example.org"]);
    expect(sent[0]).toEqual({
      kind: "sent",
      id: "quote@example.org",
      from: { address: "imap-user@example.org" },
      to: [{ address: "priya@example.org" }],
      subject: "Venue quote",
      sentAt: new Date(NOW - 23 * HOUR).toISOString(),
      url: "message://%3Cquote%40example.org%3E",
      account: "personal",
      references: ["p0@example.org"],
      text: "Hi Priya, does the venue quote include catering? Thanks, Sam",
      replies: [{ id: "reply@example.org", from: { address: "priya@example.org" }, at: new Date(NOW - 12 * HOUR).toISOString() }],
    });
    expect(sent[1]?.references).toBeUndefined();
    expect(sent[1]?.replies?.map((r) => r.id)).toEqual(["archive-reply@example.org"]);
    expect(new Set(sent.map((s) => s.id)).size).toBe(sent.length);

    // Bodies are read through box.text (BODY.PEEK) inside a folder; References are requested with the envelope.
    expect(reads).toEqual(expect.arrayContaining(["Sent:103", "Sent:102"]));
    expect(outside).toEqual([]);
    expect(opens.every((o) => o.readOnly)).toBe(true);
    expect(fetches.some((f) => f.folder === "Sent" && f.headers?.includes("references"))).toBe(true);
  });

  test("honours the day window and the limit", async () => {
    const oneDay = await readNewestSent(fixtureBox().box, { days: 1 });
    expect(oneDay.map((s) => s.id)).toEqual(["quote@example.org"]);

    const one = await readNewestSent(fixtureBox().box, { limit: 1 });
    expect(one.map((s) => s.id)).toEqual(["quote@example.org"]);
  });

  test("sent items carry references exactly as inbox items carry headers.references", async () => {
    const sent = await readNewestSent(fixtureBox().box);
    expect(sent.find((s) => s.id === "quote@example.org")?.references).toEqual(["p0@example.org"]);
    expect(sent.find((s) => s.id === "second@example.org")?.references).toBeUndefined();

    const mail = await readAll(fixtureBox().box);
    expect(mail.map((m) => m.id)).toEqual(["inbox@example.org"]);
    expect(mail[0]?.headers?.references).toEqual(["p0@example.org"]);
  });

  test("a Sent folder that cannot be read leaves the inbox alone with one warning", async () => {
    const { box } = fixtureBox({ failSent: true });
    const lines: string[] = [];
    const sent = await readNewestSent(box, { warn: (line) => lines.push(line) });
    expect(sent).toEqual([]);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("sent mail in Sent was not read");

    const items = [...(await readAll(box)), ...sent];
    expect(items.every((i) => i.kind === "mail")).toBe(true);
    expect(items.map((i) => i.id)).toEqual(["inbox@example.org"]);
  });
});

interface CliItem {
  kind: string;
  id: string;
  references?: string[];
  replies?: { id: string }[];
}

interface LogEvent {
  event: string;
  value: { path?: string; readOnly?: boolean; folder?: string };
}

const itemsOf = (stdout: string): CliItem[] => (JSON.parse(stdout) as { items?: CliItem[] }).items ?? [];
const sentOf = (stdout: string): CliItem[] => itemsOf(stdout).filter((i) => i.kind === "sent");

describe("desk-imap --sent over the command line", () => {
  let dir: string;
  let now: string;
  const logPath = (): string => join(dir, "imap.jsonl");
  const configPath = (): string => join(dir, "config.json");

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "imap-sent-test-"));
    now = new Date().toISOString();
    await mkdir(join(dir, "fake-bin"), { recursive: true });
    await mkdir(join(dir, ".config", "email"), { recursive: true });
    const config = JSON.stringify({
      defaultAccount: "Work",
      accounts: { Work: {
        from: { email: "imap-user@example.org" },
        imap: { enabled: true, host: "imap.example.org", port: 1993, tls: true, auth: { user: "imap-user@example.org", pass: "test-secret" } },
      } },
    });
    await writeFile(join(dir, ".config", "email", "config.json"), config);
    await writeFile(configPath(), config);
    await writeFile(join(dir, "list.json"), JSON.stringify([
      { uid: 12, messageId: "<inbox@example.org>", from: "sam@example.org", subject: "Inbox note", date: new Date(Date.parse(now) - 2 * HOUR).toISOString(), flags: [] },
    ]));
    await writeFile(join(dir, "fake-bin", "email"), `#!/bin/sh\ncase "$1" in\n  list) cat "${join(dir, "list.json")}" ;;\n  get) printf 'A plain inbox note.\\n\\nSecond line.\\n' ;;\n  *) exit 1 ;;\nesac\n`, { mode: 0o755 });
  });

  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  const runBin = async (bin: "desk-imap" | "desk-mail", args: string[], extra: Record<string, string> = {}) => {
    const child = Bun.spawn([process.execPath, "--preload", join(import.meta.dir, "fixtures", "imap-sent.ts"), join(import.meta.dir, "..", "bin", `${bin}.ts`), ...args], {
      env: { HOME: dir, PATH: `${join(dir, "fake-bin")}:/usr/bin:/bin`, MAIL_TEST_LOG: logPath(), MAIL_TEST_NOW: now, ...extra },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    return { code, stdout, stderr };
  };

  const onImap = (args: string[], extra: Record<string, string> = {}) => runBin("desk-imap", ["--config", configPath(), "--account", "Work", ...args], extra);

  const events = async (): Promise<LogEvent[]> => (await readFile(logPath(), "utf8").catch(() => "")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as LogEvent);

  test("prints sent items, read with EXAMINE and BODY.PEEK", async () => {
    const result = await onImap(["--sent"]);
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    const sent = sentOf(result.stdout);
    expect(sent.map((s) => s.id)).toEqual(["quote@example.org", "second@example.org"]);
    expect(sent[0]?.references).toEqual(["p0@example.org"]);
    expect(sent[0]?.replies?.map((r) => r.id)).toEqual(["reply@example.org"]);
    expect(sent[1]?.replies?.map((r) => r.id)).toEqual(["archive-reply@example.org"]);

    const log = await events();
    expect(log.filter((e) => e.event === "open").every((e) => e.value.readOnly === true)).toBe(true);
    expect(log.some((e) => e.event === "download" && e.value.folder === "Sent")).toBe(true);
  });

  test("applies --sent-days and --sent-limit", async () => {
    const oneDay = await onImap(["--sent", "--sent-days", "1"]);
    expect(oneDay.code).toBe(0);
    expect(sentOf(oneDay.stdout).map((s) => s.id)).toEqual(["quote@example.org"]);

    const one = await onImap(["--sent", "--sent-limit", "1"]);
    expect(one.code).toBe(0);
    expect(sentOf(one.stdout).map((s) => s.id)).toEqual(["quote@example.org"]);
  });

  test("refuses a window longer than 90 days and a limit over 200", async () => {
    const days = await onImap(["--sent", "--sent-days", "91"]);
    expect(days.code).toBe(1);
    expect(days.stdout).toBe("");
    expect(days.stderr.trim()).toBe("--sent-days must be a whole number from 1 to 90.");

    const limit = await onImap(["--sent", "--sent-limit", "201"]);
    expect(limit.code).toBe(1);
    expect(limit.stderr.trim()).toBe("--sent-limit must be a whole number from 1 to 200.");
  });

  test("without --sent the output carries no sent item", async () => {
    const result = await onImap([]);
    expect(result.code).toBe(0);
    expect(itemsOf(result.stdout).map((i) => i.kind)).toEqual(["mail"]);
    expect(sentOf(result.stdout)).toEqual([]);
  });

  test("unreadable sent mail leaves the inbox alone with one sent warning", async () => {
    const result = await onImap(["--sent"], { MAIL_TEST_SENT_FAIL: "1" });
    expect(result.code).toBe(0);
    expect(sentOf(result.stdout)).toEqual([]);
    expect(itemsOf(result.stdout).map((i) => i.id)).toEqual(["inbox@example.org"]);
    const lines = result.stderr.trim().split("\n").filter(Boolean);
    expect(lines.filter((l) => l.includes("sent mail in Sent was not read"))).toHaveLength(1);
  });

  test("desk-mail --sent prints the same sent items on this fixture mailbox", async () => {
    const imap = await onImap(["--sent"]);
    const mail = await runBin("desk-mail", ["--account", "Work", "--sent"]);
    expect(imap.code).toBe(0);
    expect(mail.code).toBe(0);
    expect(sentOf(imap.stdout)).toEqual(sentOf(mail.stdout));
  });
});
