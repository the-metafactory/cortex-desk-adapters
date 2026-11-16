import { mock } from "bun:test";
import { appendFileSync } from "node:fs";
import { Readable } from "node:stream";

// Loaded only in desk-imap subprocesses; no real server or mailbox is contacted.
const log = (event: string, value: unknown): void => {
  const path = process.env.MAIL_TEST_LOG;
  if (path) appendFileSync(path, `${JSON.stringify({ event, value })}\n`);
};

const NOW = process.env.MAIL_TEST_NOW ? Date.parse(process.env.MAIL_TEST_NOW) : Date.now();
const HOUR = 3_600_000;
const DAY = 86_400_000;

interface Message {
  uid: number;
  messageId: string;
  inReplyTo?: string;
  references?: string[];
  subject: string;
  from: string;
  to: string[];
  date: Date;
  seen: boolean;
  body: string;
}

const INBOX: Message[] = [
  { uid: 11, messageId: "<reply@example.org>", inReplyTo: "<quote@example.org>", subject: "Re: Venue quote", from: "priya@example.org", to: ["imap-user@example.org"], date: new Date(NOW - 12 * HOUR), seen: true, body: "Yes, catering is included." },
  { uid: 12, messageId: "<inbox@example.org>", references: ["<p0@example.org>"], subject: "Inbox note", from: "sam@example.org", to: ["imap-user@example.org"], date: new Date(NOW - 2 * HOUR), seen: false, body: "A plain inbox note.\n\nSecond line." },
];

const SENT: Message[] = [
  { uid: 103, messageId: "<quote@example.org>", references: ["<p0@example.org>"], subject: "Venue quote", from: "imap-user@example.org", to: ["priya@example.org"], date: new Date(NOW - 23 * HOUR), seen: true, body: "Hi Priya,\n\ndoes the venue quote include catering?\n\nThanks, Sam\n\nOn Mon, 26 Oct 2026 at 08:00, Priya wrote:\n> Here is the quote." },
  { uid: 102, messageId: "<second@example.org>", subject: "Second", from: "imap-user@example.org", to: ["bob@example.org"], date: new Date(NOW - 2 * DAY), seen: true, body: "Can you send the deck?" },
  { uid: 101, messageId: "<old@example.org>", subject: "Old", from: "imap-user@example.org", to: ["priya@example.org"], date: new Date(NOW - 20 * DAY), seen: true, body: "Old mail." },
];

const ARCHIVE: Message[] = [
  { uid: 301, messageId: "<archive-reply@example.org>", inReplyTo: "<second@example.org>", subject: "Re: Second", from: "bob@example.org", to: ["imap-user@example.org"], date: new Date(NOW - 1 * HOUR), seen: true, body: "Deck is on its way." },
];

const FOLDERS: Record<string, Message[]> = { INBOX, Sent: SENT, Archive: ARCHIVE };

/** Only the requested headers, so a `references`-only fetch cannot pick up the message's own Message-ID. */
const headersOf = (m: Message, requested?: string[]): Buffer | undefined => {
  if (!requested) return undefined;
  const references = m.references?.length ? [`References: ${m.references.map((r) => `<${r}>`).join(" ")}`] : [];
  if (requested.length === 1 && requested[0]?.toLowerCase() === "references") {
    return references.length ? Buffer.from(`${references[0]}\r\n\r\n`) : undefined;
  }
  const lines = [
    `Message-ID: <${m.messageId}>`,
    `Subject: ${m.subject}`,
    `From: ${m.from}`,
    `To: ${m.to.join(", ")}`,
    `Date: ${m.date.toUTCString()}`,
    ...(m.inReplyTo ? [`In-Reply-To: <${m.inReplyTo}>`] : []),
    ...references,
  ];
  return Buffer.from(`${lines.join("\r\n")}\r\n\r\n`);
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
    private current(): Message[] { return FOLDERS[this.open] ?? []; }
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
        .map((m) => ({
          uid: m.uid,
          ...(query.envelope ? { envelope: { messageId: m.messageId, ...(m.inReplyTo ? { inReplyTo: m.inReplyTo } : {}), subject: m.subject, date: m.date, from: [{ address: m.from }], to: m.to.map((address) => ({ address })) } } : {}),
          ...(query.bodyStructure ? { bodyStructure: { part: "1", type: "text/plain" } } : {}),
          ...(query.internalDate ? { internalDate: m.date } : {}),
          ...(query.flags ? { flags: new Set(m.seen ? ["\\Seen"] : []) } : {}),
          ...((): { headers?: Buffer } => {
            const headers = headersOf(m, query.headers);
            return headers ? { headers } : {};
          })(),
        }));
    }
    async download(uid: string, part: string, _options: unknown) {
      const m = this.current().find((x) => x.uid === Number(uid));
      log("download", { folder: this.open, uid: Number(uid), part });
      return { content: Readable.from([Buffer.from(m?.body ?? "")]) };
    }
  },
}));
