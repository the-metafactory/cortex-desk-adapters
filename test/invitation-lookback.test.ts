import { describe, expect, test } from "bun:test";
import type { DeskMailInvitation } from "../src/contract";
import { parseReply } from "../src/invitation";
import { addReply, answeredInSent, invitationOpen, invitationOver, lookbackItems, type LookbackCandidate } from "../src/invitation-lookback";

const NOW = Date.parse("2026-11-02T12:00:00Z");

const invitation = (over: Partial<DeskMailInvitation> = {}): DeskMailInvitation => ({
  method: "REQUEST",
  uid: "uid-1",
  sequence: 1,
  summary: "Planning",
  start: "2026-11-05T07:00:00.000Z",
  end: "2026-11-05T08:00:00.000Z",
  organizer: { address: "olga@example.org" },
  attendee: { address: "pat@example.com", status: "NEEDS-ACTION" },
  attendees: 2,
  ...over,
});

const candidate = (uid: number, over: Partial<LookbackCandidate> = {}): LookbackCandidate => ({
  uid,
  envelope: { messageId: `<m${uid}@example.org>`, subject: `Invitation ${uid}`, date: new Date(NOW - uid * 3_600_000), from: [{ name: "Olga", address: "Olga@Example.org" }] },
  flags: new Set(["\\Seen"]),
  invitation: invitation({ uid: `uid-${uid}` }),
  ...over,
});

const REPLY = ["BEGIN:VCALENDAR", "METHOD:REPLY", "BEGIN:VEVENT", "UID:uid-1", "SEQUENCE:2", "ATTENDEE;PARTSTAT=ACCEPTED:mailto:pat@example.com", "END:VEVENT", "END:VCALENDAR"].join("\r\n");

describe("parseReply", () => {
  test("reads the UID and SEQUENCE of an iTIP REPLY", () => {
    expect(parseReply(REPLY)).toEqual({ uid: "uid-1", sequence: 2 });
  });

  test("a REQUEST or a reply without a UID is not a reply", () => {
    expect(parseReply(REPLY.replace("METHOD:REPLY", "METHOD:REQUEST"))).toBeNull();
    expect(parseReply(REPLY.replace("UID:uid-1\r\n", ""))).toBeNull();
  });
});

describe("invitation state", () => {
  test("a reply in Sent answers the same or an older SEQUENCE, not a newer one", () => {
    const replies = new Map<string, number>();
    addReply(replies, { uid: "uid-1", sequence: 1 });
    addReply(replies, { uid: "uid-1", sequence: 0 });
    expect(replies.get("uid-1")).toBe(1);
    expect(answeredInSent(invitation({ sequence: 1 }), replies)).toBe(true);
    expect(answeredInSent(invitation({ sequence: 2 }), replies)).toBe(false);
    expect(answeredInSent(invitation({ uid: "other" }), replies)).toBe(false);
  });

  test("an event is over at its end, or its start without an end; a recurring one never", () => {
    expect(invitationOver(invitation(), NOW)).toBe(false);
    expect(invitationOver(invitation({ start: "2026-11-02T10:00:00Z", end: "2026-11-02T13:00:00Z" }), NOW)).toBe(false);
    expect(invitationOver(invitation({ start: "2026-11-02T10:00:00Z", end: "2026-11-02T11:00:00Z" }), NOW)).toBe(true);
    const { end: _end, ...noEnd } = invitation({ start: "2026-11-01T10:00:00Z" });
    expect(invitationOver(noEnd, NOW)).toBe(true);
    expect(invitationOver(invitation({ start: "2026-10-01T10:00:00Z", end: "2026-10-01T11:00:00Z", recurring: true }), NOW)).toBe(false);
  });

  test("being read does not answer an invitation", () => {
    expect(invitationOpen(invitation(), new Map(), NOW)).toBe(true);
  });
});

describe("lookbackItems", () => {
  const input = { account: "work", listed: new Set<string>(), replies: new Map<string, number>(), now: NOW, limit: 10 };

  test("adds an open read invitation as a read mail that carries it", () => {
    const [first, ...rest] = lookbackItems([candidate(3)], input);
    expect(rest).toEqual([]);
    expect(first?.uid).toBe(3);
    const mail = first?.mail;
    expect(mail).toMatchObject({ kind: "mail", id: "m3@example.org", from: { name: "Olga", address: "olga@example.org" }, subject: "Invitation 3", unread: false, account: "work", invitation: { uid: "uid-3" } });
    expect(mail?.url).toBe("message://%3Cm3%40example.org%3E");
  });

  test("skips answered, over and already listed invitations, and mail without a date", () => {
    const replies = new Map([["uid-1", 1]]);
    const items = lookbackItems([
      candidate(1),
      candidate(2, { invitation: invitation({ uid: "uid-2", start: "2026-10-30T07:00:00Z", end: "2026-10-30T08:00:00Z" }) }),
      candidate(3),
      candidate(4, { envelope: { messageId: "<m4@example.org>", from: [{ address: "olga@example.org" }] } }),
      candidate(5),
    ], { ...input, replies, listed: new Set(["m3@example.org"]) });
    expect(items.map((m) => m.mail.id)).toEqual(["m5@example.org"]);
  });

  test("keeps the newest first and stops at the limit", () => {
    const items = lookbackItems([candidate(1), candidate(9, { flags: new Set() }), candidate(5)], { ...input, limit: 2 });
    expect(items.map((m) => [m.mail.id, m.mail.unread])).toEqual([["m9@example.org", true], ["m5@example.org", false]]);
  });
});
