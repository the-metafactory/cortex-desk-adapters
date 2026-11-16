import type { ReadMessage, ReadQuery } from "../../src/imap";

const HOUR = 3_600_000;
const DAY = 86_400_000;

export const SELF = ["imap-user@example.org"];

export interface FixtureMessage {
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
  type?: "text/plain" | "text/html" | "text/calendar";
}

export interface FixtureFolders {
  INBOX: FixtureMessage[];
  Sent: FixtureMessage[];
  "Sent Items": FixtureMessage[];
  Archive: FixtureMessage[];
}

/** One message set per folder, dated relative to `now`, so the preload mock and the unit fixture read the same mail. */
export function fixtureMessages(now: number): FixtureFolders {
  const self = SELF[0]!;
  return {
    INBOX: [
      { uid: 11, messageId: "<reply@example.org>", inReplyTo: "<quote@example.org>", subject: "Re: Venue quote", from: "priya@example.org", to: SELF, date: new Date(now - 12 * HOUR), seen: true, body: "Yes, catering is included." },
      { uid: 12, messageId: "<inbox@example.org>", references: ["<p0@example.org>"], subject: "Inbox note", from: "sam@example.org", to: SELF, date: new Date(now - 2 * HOUR), seen: false, body: "A plain inbox note.\n\nSecond line." },
    ],
    Sent: [
      { uid: 103, messageId: "<quote@example.org>", references: ["<p0@example.org>"], subject: "Venue quote", from: self, to: ["priya@example.org"], date: new Date(now - 23 * HOUR), seen: true, body: "Hi Priya,\n\ndoes the venue quote include catering?\n\nThanks, Sam\n\nOn Mon, 26 Oct 2026 at 08:00, Priya wrote:\n> Here is the quote." },
      { uid: 102, messageId: "<second@example.org>", subject: "Second", from: self, to: ["bob@example.org"], date: new Date(now - 2 * DAY), seen: true, body: "Can you send the deck?" },
      { uid: 101, messageId: "<old@example.org>", subject: "Old", from: self, to: ["priya@example.org"], date: new Date(now - 20 * DAY), seen: true, body: "Old mail." },
    ],
    "Sent Items": [
      { uid: 201, messageId: "<quote@example.org>", references: ["<p0@example.org>"], subject: "Venue quote", from: self, to: ["priya@example.org"], date: new Date(now - 23 * HOUR), seen: true, body: "Hi Priya, duplicate." },
    ],
    Archive: [
      { uid: 301, messageId: "<archive-reply@example.org>", inReplyTo: "<second@example.org>", subject: "Re: Second", from: "bob@example.org", to: SELF, date: new Date(now - 1 * HOUR), seen: true, body: "Deck is on its way." },
    ],
  };
}

/** Only the requested headers, so a `references`-only fetch cannot pick up the message's own Message-ID. */
export function headersOf(m: FixtureMessage, requested?: string[]): Buffer | undefined {
  if (!requested) return undefined;
  const references = m.references?.length ? [`References: ${m.references.map((id) => `<${id}>`).join(" ")}`] : [];
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
}

/** What imapflow returns for one fetched message: only the fields the query asked for. */
export function toFetched(m: FixtureMessage, query: ReadQuery): ReadMessage {
  const headers = headersOf(m, query.headers);
  return {
    uid: m.uid,
    ...(query.envelope ? { envelope: { messageId: m.messageId, ...(m.inReplyTo ? { inReplyTo: m.inReplyTo } : {}), subject: m.subject, date: m.date, from: [{ address: m.from }], to: m.to.map((address) => ({ address })) } } : {}),
    ...(query.bodyStructure ? { bodyStructure: { part: "1", type: m.type ?? "text/plain" } } : {}),
    ...(query.internalDate ? { internalDate: m.date } : {}),
    ...(query.flags ? { flags: new Set(m.seen ? ["\\Seen"] : []) } : {}),
    ...(headers ? { headers } : {}),
  };
}
