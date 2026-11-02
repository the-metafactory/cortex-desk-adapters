import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildReply, calendarPart, durationMs, foldLine, parseInvitation, readInviteReplyRequest, replyMessage } from "../src/invitation";
import { answerInvitation, type InviteReplyDeps } from "../src/invite-reply";
import { curlConfig, sendMail, type SmtpAccount } from "../src/smtp";
import type { DeskInviteReplyRequest } from "../src/contract";

const REQUEST = [
  "BEGIN:VCALENDAR",
  "METHOD:REQUEST",
  "PRODID:Microsoft Exchange Server 2010",
  "VERSION:2.0",
  "BEGIN:VTIMEZONE",
  "TZID:W. Europe Standard Time",
  "BEGIN:STANDARD",
  "DTSTART:16010101T030000",
  "TZOFFSETFROM:+0200",
  "TZOFFSETTO:+0100",
  "END:STANDARD",
  "END:VTIMEZONE",
  "BEGIN:VEVENT",
  "ORGANIZER;CN=Olga Organiser:mailto:olga@example.org",
  "ATTENDEE;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE;CN=Pat Principal:mailto:Pat@Example.com",
  "ATTENDEE;ROLE=OPT-PARTICIPANT;PARTSTAT=NEEDS-ACTION;CN=Other:mailto:other@example.net",
  "DESCRIPTION:Long agenda that stays out of the reply",
  "UID:040000008200E00074C5B7101A82E008",
  "SUMMARY:Budget review\\, Q1",
  "DTSTART;TZID=W. Europe Standard Time:20261104T140000",
  "DTEND;TZID=W. Europe Standard Time:20261104T150000",
  "SEQUENCE:2",
  "LOCATION:Room 4",
  "BEGIN:VALARM",
  "ACTION:DISPLAY",
  "TRIGGER:-PT15M",
  "END:VALARM",
  "END:VEVENT",
  "END:VCALENDAR",
].join("\r\n");

const SELF = ["pat@example.com"];

describe("parseInvitation", () => {
  test("reads a meeting request with a Windows time zone and finds the principal among the attendees", () => {
    const inv = parseInvitation(REQUEST, SELF);
    expect(inv).toEqual({
      method: "REQUEST",
      uid: "040000008200E00074C5B7101A82E008",
      sequence: 2,
      summary: "Budget review, Q1",
      start: "2026-11-04T13:00:00.000Z",
      end: "2026-11-04T14:00:00.000Z",
      location: "Room 4",
      organizer: { address: "olga@example.org", name: "Olga Organiser" },
      attendee: { address: "pat@example.com", status: "NEEDS-ACTION", rsvp: true },
      attendees: 2,
    });
  });

  test("a cancellation, a request without organizer and plain text are not invitations", () => {
    expect(parseInvitation(REQUEST.replace("METHOD:REQUEST", "METHOD:CANCEL"), SELF)).toBeNull();
    expect(parseInvitation(REQUEST.replace(/ORGANIZER[^\r\n]*\r\n/, ""), SELF)).toBeNull();
    expect(parseInvitation("hello", SELF)).toBeNull();
  });

  test("a DURATION gives the end, an all-day event lasts a day, and a recurring one says so", () => {
    const withDuration = REQUEST.replace(/DTEND[^\r\n]*\r\n/, "DURATION:PT90M\r\nRRULE:FREQ=WEEKLY\r\n");
    expect(parseInvitation(withDuration, SELF)).toMatchObject({ end: "2026-11-04T14:30:00.000Z", recurring: true });
    const allDay = REQUEST.replace(/DTSTART;[^\r\n]*\r\n/, "DTSTART;VALUE=DATE:20261104\r\n").replace(/DTEND[^\r\n]*\r\n/, "");
    const inv = parseInvitation(allDay, SELF);
    expect(inv?.allDay).toBe(true);
    expect(Date.parse(inv?.end ?? "") - Date.parse(inv?.start ?? "")).toBe(86_400_000);
    expect(durationMs("P1DT2H")).toBe(26 * 3_600_000);
    expect(durationMs("P")).toBeNull();
  });

  test("without the principal among the attendees there is no attendee", () => {
    expect(parseInvitation(REQUEST, ["someone@else.org"])?.attendee).toBeUndefined();
  });
});

describe("buildReply", () => {
  test("answers with METHOD:REPLY, one attendee with the answer, the request's identity and its time zone", () => {
    const ics = buildReply(REQUEST, { attendee: "pat@example.com", reply: "decline", now: Date.UTC(2026, 10, 2, 9, 0, 0) });
    expect(ics).toContain("METHOD:REPLY\r\n");
    expect(ics).toContain("UID:040000008200E00074C5B7101A82E008\r\n");
    expect(ics).toContain("SEQUENCE:2\r\n");
    expect(ics).toContain("ORGANIZER;CN=Olga Organiser:mailto:olga@example.org\r\n");
    expect(ics).toContain('ATTENDEE;PARTSTAT=DECLINED;CN="Pat Principal":mailto:Pat@Example.com\r\n');
    expect(ics).toContain("DTSTAMP:20261102T090000Z\r\n");
    expect(ics).toContain("TZID:W. Europe Standard Time");
    expect(ics.match(/ATTENDEE/g)?.length).toBe(1);
    expect(ics).not.toContain("DESCRIPTION");
    expect(ics).not.toContain("VALARM");
  });

  test("accept says ACCEPTED", () => {
    expect(buildReply(REQUEST, { attendee: "pat@example.com", reply: "accept", now: 0 })).toContain("PARTSTAT=ACCEPTED");
  });

  test("refuses when the principal is not an attendee or the mail is not a request", () => {
    expect(() => buildReply(REQUEST, { attendee: "someone@else.org", reply: "accept", now: 0 })).toThrow("not listed as an attendee");
    expect(() => buildReply(REQUEST.replace("METHOD:REQUEST", "METHOD:CANCEL"), { attendee: "pat@example.com", reply: "accept", now: 0 })).toThrow("not a meeting request");
  });

  test("folds long lines at 75 octets", () => {
    const folded = foldLine(`SUMMARY:${"ä".repeat(60)}`);
    for (const line of folded.split("\r\n")) expect(new TextEncoder().encode(line).length).toBeLessThanOrEqual(75);
    expect(folded.split("\r\n").map((l, i) => (i === 0 ? l : l.slice(1))).join("")).toBe(`SUMMARY:${"ä".repeat(60)}`);
  });
});

describe("replyMessage", () => {
  test("is an iMIP reply to the organizer with a text/calendar method=REPLY part", () => {
    const msg = replyMessage({ from: "pat@example.com", fromName: "Pat Principal", to: "olga@example.org", reply: "decline", summary: "Büdget", ics: "BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n", inReplyTo: "orig@example.org", messageId: "new@example.com", boundary: "b1", date: new Date(Date.UTC(2026, 10, 2)) });
    expect(msg).toContain("To: olga@example.org\r\n");
    expect(msg).toContain(`Subject: =?UTF-8?B?${Buffer.from("Declined: Büdget").toString("base64")}?=\r\n`);
    expect(msg).toContain("In-Reply-To: <orig@example.org>\r\n");
    expect(msg).toContain("Content-Type: text/calendar; charset=utf-8; method=REPLY\r\n");
    expect(msg).toContain(Buffer.from("BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n").toString("base64"));
  });
});

describe("readInviteReplyRequest", () => {
  const ok = { action: "invite-reply", account: "work", messageId: "<m@x>", uid: "u1", reply: "decline", requestId: "req-12345678" };
  test("accepts a well-formed request and strips the angle brackets", () => {
    expect(readInviteReplyRequest(JSON.stringify(ok))).toEqual({ ...ok, messageId: "m@x" } as DeskInviteReplyRequest);
  });
  test("refuses another action, another answer, or a missing request id", () => {
    expect(() => readInviteReplyRequest(JSON.stringify({ ...ok, action: "draft" }))).toThrow("only answers invitations");
    expect(() => readInviteReplyRequest(JSON.stringify({ ...ok, reply: "tentative" }))).toThrow("accept or decline");
    expect(() => readInviteReplyRequest(JSON.stringify({ ...ok, requestId: undefined }))).toThrow("request id");
  });
});

describe("calendarPart", () => {
  test("finds the text/calendar leaf, else an application/ics attachment", () => {
    expect(calendarPart({ type: "multipart/alternative", childNodes: [{ part: "1", type: "text/plain" }, { part: "2", type: "text/calendar" }] })).toBe("2");
    expect(calendarPart({ type: "multipart/mixed", childNodes: [{ part: "1", type: "text/plain" }, { part: "2", type: "application/ics" }] })).toBe("2");
    expect(calendarPart({ type: "text/plain" })).toBeUndefined();
  });
});

const ACCOUNT: SmtpAccount = { name: "work", host: "smtp.example.com", port: 587, secure: false, user: "pat@example.com", pass: 'se"cret', from: "pat@example.com", fromName: "Pat Principal" };

describe("sendMail", () => {
  test("keeps the password out of argv and requires STARTTLS", async () => {
    const calls: { argv: string[]; stdin?: string }[] = [];
    await sendMail(ACCOUNT, "olga@example.org", "msg", async (argv, stdin) => { calls.push({ argv, ...(stdin === undefined ? {} : { stdin }) }); return { code: 0, stdout: "", stderr: "" }; });
    expect(calls[0]?.argv.join(" ")).not.toContain("cret");
    expect(calls[0]?.stdin).toContain('user = "pat@example.com:se\\"cret"');
    expect(calls[0]?.stdin).toContain("ssl-reqd");
    expect(calls[0]?.stdin).toContain('mail-rcpt = "olga@example.org"');
  });
  test("a refused submission is a refusal with curl's reason", async () => {
    await expect(sendMail(ACCOUNT, "olga@example.org", "msg", async () => ({ code: 55, stdout: "", stderr: "curl: (55) Recipient rejected" }))).rejects.toThrow("Recipient rejected");
  });
  test("a secure account uses implicit TLS", () => {
    expect(curlConfig({ ...ACCOUNT, secure: true, port: 465 }, "o@example.org")).toContain('url = "smtps://smtp.example.com:465"');
  });
});

describe("answerInvitation", () => {
  const req: DeskInviteReplyRequest = { action: "invite-reply", account: "work", messageId: "orig@example.org", uid: "040000008200E00074C5B7101A82E008", reply: "decline", requestId: "req-12345678" };
  const withLedger = async (work: (deps: InviteReplyDeps, sent: { rcpt: string; message: string }[]) => Promise<void>): Promise<void> => {
    const dir = await mkdtemp(join(tmpdir(), "invite-test-"));
    const sent: { rcpt: string; message: string }[] = [];
    try {
      await work({ source: async () => REQUEST, smtp: async () => ACCOUNT, send: async (_a, rcpt, message) => { sent.push({ rcpt, message }); }, ledgerPath: join(dir, "ledger.json"), now: () => Date.UTC(2026, 10, 2), newId: () => "id1" }, sent);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  };

  test("sends the decline to the organizer once; a retry with the same request id sends nothing", async () => {
    await withLedger(async (deps, sent) => {
      const first = await answerInvitation(req, deps);
      expect(first).toEqual({ id: "id1@example.com", message: "The decline went to Olga Organiser." });
      expect(sent).toHaveLength(1);
      expect(sent[0]?.rcpt).toBe("olga@example.org");
      expect(sent[0]?.message).toContain("Subject: Declined: Budget review, Q1\r\n");
      const again = await answerInvitation(req, deps);
      expect(again.message).toBe("The decline was already sent.");
      expect(sent).toHaveLength(1);
    });
  });

  test("refuses a changed invitation, a mail without one, and a principal who is not invited", async () => {
    await withLedger(async (deps, sent) => {
      await expect(answerInvitation({ ...req, uid: "other" }, deps)).rejects.toThrow("not the one the Desk showed");
      await expect(answerInvitation(req, { ...deps, source: async () => undefined })).rejects.toThrow("carries no calendar invitation");
      await expect(answerInvitation(req, { ...deps, smtp: async () => ({ ...ACCOUNT, from: "x@else.org", user: "x@else.org" }) })).rejects.toThrow("not listed as an attendee");
      expect(sent).toHaveLength(0);
    });
  });
});

describe("review round 1", () => {
  test("an ASCII display name with a comma is quoted in From", () => {
    const msg = replyMessage({ from: "pat@example.com", fromName: "Principal, Pat", to: "o@example.org", reply: "accept", summary: "S", ics: "", inReplyTo: "a@b", messageId: "c@d", boundary: "b", date: new Date(0) });
    expect(msg).toContain('From: "Principal, Pat" <pat@example.com>\r\n');
  });
  test("a time zone the Desk cannot resolve drops the invitation instead of guessing its time", () => {
    expect(parseInvitation(REQUEST.replaceAll("W. Europe Standard Time", "Tokyo Standard Time"), SELF)).toBeNull();
  });
});
