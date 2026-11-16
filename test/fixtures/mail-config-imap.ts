import { mock } from "bun:test";
import { appendFileSync } from "node:fs";
import { Readable } from "node:stream";

const log = (event: string, value: unknown) => appendFileSync(process.env.MAIL_TEST_LOG!, `${JSON.stringify({ event, value })}\n`);

// Loaded only in command-test subprocesses; no real server or mailbox is contacted.
mock.module("imapflow", () => ({
  ImapFlow: class {
    capabilities = new Set(["MOVE"]);
    constructor(private options: unknown) {}
    on() {}
    async connect() { log("connect", this.options); }
    async logout() { log("logout", null); }
    async getMailboxLock(path: string, options: unknown) {
      log("open", { path, options });
      return { release() {} };
    }
    async list() {
      return ["Archive", "Trash", "Junk", "Drafts"].map((path) => ({ path, name: path, specialUse: `\\${path}` }));
    }
    async search() { return [7]; }
    async fetchAll() {
      return [{ uid: 7, envelope: { messageId: "<message@example.org>" }, flags: new Set(), bodyStructure: { type: "text/calendar", part: "1" } }];
    }
    async fetchOne() { return { source: Buffer.from("Subject: Example\r\n\r\nOriginal mail") }; }
    async messageMove(uids: number[], target: string) { log("move", { uids, target }); return true; }
    async append(folder: string, content: Buffer) { log("append", { folder, content: content.toString() }); return true; }
    async download() { return { content: Readable.from([Buffer.from(process.env.MAIL_TEST_ICS!)]) }; }
  },
}));
