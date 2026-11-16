import { mock } from "bun:test";
import { appendFileSync } from "node:fs";
import { Readable } from "node:stream";
import { fixtureMessages, toFetched, type FixtureMessage } from "./imap-sent-data";

// Loaded only in desk-imap subprocesses; no real server or mailbox is contacted.
const log = (event: string, value: unknown): void => {
  const path = process.env.MAIL_TEST_LOG;
  if (path) appendFileSync(path, `${JSON.stringify({ event, value })}\n`);
};

const NOW = process.env.MAIL_TEST_NOW ? Date.parse(process.env.MAIL_TEST_NOW) : Date.now();
const MESSAGES = fixtureMessages(NOW);
const FOLDERS: Record<string, FixtureMessage[]> = {
  INBOX: MESSAGES.INBOX,
  Sent: MESSAGES.Sent,
  "Sent Items": MESSAGES["Sent Items"],
  Archive: MESSAGES.Archive,
};

mock.module("imapflow", () => ({
  ImapFlow: class {
    private open = "";
    constructor(private options: unknown) {}
    on() {}
    async connect() { log("connect", this.options); }
    async logout() { log("logout", null); }
    async list() {
      return [
        { path: "INBOX", name: "INBOX", specialUse: "\\Inbox" },
        { path: "Sent", name: "Sent", specialUse: "\\Sent" },
        { path: "Archive", name: "Archive", specialUse: "\\Archive" },
      ];
    }
    async getMailboxLock(path: string, options: { readOnly?: boolean } = {}) {
      log("open", { path, readOnly: options.readOnly === true });
      if (path === "Sent" && process.env.MAIL_TEST_SENT_FAIL === "1") throw new Error("the Sent folder is unavailable");
      this.open = path;
      return { release: () => { log("release", path); } };
    }
    private current(): FixtureMessage[] { return FOLDERS[this.open] ?? []; }
    async search(query: { since?: Date; seen?: boolean }, _options: unknown) {
      const messages = this.current().filter((m) => (query.seen === false ? !m.seen : query.since ? m.date >= query.since : true));
      const uids = messages.map((m) => m.uid).sort((a, b) => b - a);
      log("search", { folder: this.open, query, uids });
      return uids;
    }
    async fetchAll(uids: number[], query: { envelope?: boolean; bodyStructure?: boolean; internalDate?: boolean; flags?: boolean; headers?: string[] }, _options: unknown) {
      log("fetch", { folder: this.open, uids, headers: query.headers });
      return this.current()
        .filter((m) => uids.includes(m.uid))
        .map((m) => toFetched(m, query));
    }
    async download(uid: string, part: string, _options: unknown) {
      const m = this.current().find((x) => x.uid === Number(uid));
      log("download", { folder: this.open, uid: Number(uid), part });
      return { content: Readable.from([Buffer.from(m?.body ?? "")]) };
    }
  },
}));
