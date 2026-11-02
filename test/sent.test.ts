import { describe, expect, it } from "bun:test";
import { messageIds, parseMailHeaders } from "../src/mail-headers";
import { replyCandidate, repliesTo, sentFolders, sentText, toSentMail, withReplies, type ReplyCandidate } from "../src/sent";

const me = { name: "Sam Sender", address: "Sam@Example.org" };
const sentAt = new Date("2026-10-26T09:00:00Z");

describe("sentText", () => {
  it("keeps the new text and stops at the quoted original", () => {
    const body = ["Hi Priya,", "", "does the venue quote include catering?", "", "Thanks, Sam", "", "On Mon, 26 Oct 2026 at 08:00, Priya wrote:", "> Here is the quote."].join("\r\n");
    expect(sentText(body)).toBe("Hi Priya, does the venue quote include catering? Thanks, Sam");
  });

  it("stops at a German attribution, an Outlook header block and a signature", () => {
    expect(sentText("Kannst du mir das bis Freitag schicken?\nAm 26.10.2026 um 10:00 schrieb Priya <p@example.org>:\n> alt")).toBe("Kannst du mir das bis Freitag schicken?");
    expect(sentText("Please confirm.\n\nFrom: Priya\nSent: Monday")).toBe("Please confirm.");
    expect(sentText("See attached.\n-- \nSam")).toBe("See attached.");
  });

  it("caps long text and returns nothing for an empty body", () => {
    expect(sentText("word ".repeat(400), 50)?.length).toBe(50);
    expect(sentText("> only a quote")).toBeUndefined();
  });
});

describe("toSentMail", () => {
  it("lists To and Cc once, lowercased, with the thread headers", () => {
    const item = toSentMail(
      { messageId: "<s1@example.org>", inReplyTo: "<p0@example.org>", subject: "Venue  quote", date: sentAt, from: [me], to: [{ name: "Priya Shah", address: "Priya@Example.org" }], cc: [{ address: "priya@example.org" }, { address: "lee@example.org" }] },
      "personal",
      { text: "Does it include catering?", references: ["p0@example.org"] },
    );
    expect(item).toEqual({
      kind: "sent",
      id: "s1@example.org",
      from: { name: "Sam Sender", address: "sam@example.org" },
      to: [{ name: "Priya Shah", address: "priya@example.org" }, { address: "lee@example.org" }],
      subject: "Venue quote",
      sentAt: sentAt.toISOString(),
      text: "Does it include catering?",
      url: "message://%3Cs1%40example.org%3E",
      account: "personal",
      inReplyTo: "p0@example.org",
      references: ["p0@example.org"],
    });
  });

  it("refuses a message without Message-ID, date or a recipient", () => {
    expect(toSentMail({ subject: "x", date: sentAt, from: [me], to: [{ address: "a@example.org" }] }, "work")).toBeNull();
    expect(toSentMail({ messageId: "<a@b>", subject: "x", from: [me], to: [{ address: "a@example.org" }] }, "work")).toBeNull();
    expect(toSentMail({ messageId: "<a@b>", subject: "x", date: sentAt, from: [me], to: [{ address: "not an address" }] }, "work")).toBeNull();
  });
});

describe("replies", () => {
  const sent = { id: "s1@example.org", from: { address: "sam@example.org" } };
  const candidate = (id: string, address: string, at: string, parents: string[]): ReplyCandidate => ({ id, from: { address }, at, parents });

  it("finds replies by In-Reply-To or References from anyone but the sender, oldest first", () => {
    const found = repliesTo(sent, [
      candidate("r2@x", "lee@example.org", "2026-10-28T10:00:00Z", ["p0@example.org", "s1@example.org"]),
      candidate("r1@x", "priya@example.org", "2026-10-27T10:00:00Z", ["s1@example.org"]),
      candidate("own@x", "sam@example.org", "2026-10-27T11:00:00Z", ["s1@example.org"]),
      candidate("other@x", "priya@example.org", "2026-10-27T12:00:00Z", ["s9@example.org"]),
    ]);
    expect(found.map((r) => r.id)).toEqual(["r1@x", "r2@x"]);
  });

  it("builds a candidate from the envelope and References, and skips a message that replies to nothing", () => {
    const env = { messageId: "<r1@x>", inReplyTo: "<s1@example.org>", date: sentAt, from: [{ address: "Priya@example.org" }] };
    expect(replyCandidate(env, ["p0@example.org", "s1@example.org"])).toEqual({ id: "r1@x", from: { address: "priya@example.org" }, at: sentAt.toISOString(), parents: ["s1@example.org", "p0@example.org"] });
    expect(replyCandidate({ ...env, inReplyTo: undefined }, [])).toBeNull();
    const item = toSentMail({ messageId: "<s1@example.org>", subject: "q", date: sentAt, from: [me], to: [{ address: "priya@example.org" }] }, "personal");
    expect(item && withReplies(item, [])).toEqual(item);
  });

  it("reads References into Message-IDs, the closest ancestors last", () => {
    expect(messageIds("<a@x> <b@x>\r\n <c@x> <a@x>")).toEqual(["a@x", "b@x", "c@x"]);
    expect(messageIds(Array.from({ length: 25 }, (_, i) => `<m${i}@x>`).join(" "))).toHaveLength(20);
    expect(parseMailHeaders("References: <a@x>\r\n <b@x>\r\n")?.references).toEqual(["a@x", "b@x"]);
  });
});

it("reads the flagged Sent folder and every folder with a usual Sent name", () => {
  const boxes = [
    { path: "INBOX", name: "INBOX", specialUse: "\\Inbox" },
    { path: "Deleted Items/Sent", name: "Sent", specialUse: "\\Sent" },
    { path: "Sent Items", name: "Sent Items" },
    { path: "Archiv/Sent", name: "Sent" },
  ];
  expect(sentFolders(boxes)).toEqual(["Deleted Items/Sent", "Sent Items"]);
  expect(sentFolders([{ path: "INBOX", name: "INBOX" }])).toEqual([]);
});
