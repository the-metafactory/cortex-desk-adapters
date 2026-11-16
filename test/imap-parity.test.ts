import { describe, expect, test } from "bun:test";
import type { DeskMailInvitation, DeskMailLink, DeskSourceMail } from "../src/contract";
import { invitationsIn, linksIn, lookbackIn, readItems, type ReadBox, type ReadMessage, type ReadQuery } from "../src/imap";
import { invitationOpen, lookbackItems } from "../src/invitation-lookback";
import { readFirstParagraph, toDeskMail as emailToDeskMail, type EmailListEntry } from "../src/mail";
import { bareMessageId } from "../src/move";

const NOW = Date.parse("2026-11-02T12:00:00Z");
const SELF = ["pat@example.com"];

const ics = (uid: string, method: string, start: string, extra: string[] = []): string =>
  [
    "BEGIN:VCALENDAR",
    `METHOD:${method}`,
    "VERSION:2.0",
    "BEGIN:VEVENT",
    "ORGANIZER;CN=Olga:mailto:olga@example.org",
    "ATTENDEE;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:pat@example.com",
    `UID:${uid}`,
    "SUMMARY:Planning",
    `DTSTART:${start}`,
    `DTEND:${start.replace("T1", "T2")}`,
    ...extra,
    "END:VEVENT",
    "END:VCALENDAR",
  ].join("\r\n");

const HTML_ONLY = `<html><head><title>x</title><style>p{color:red}</style></head><body>
<!-- note --><script>var a = 1;</script>
<h1>Your invoice is ready</h1>
<p style="display:none">hidden words</p>
<p>The invoice for <b>October</b> is ready.&nbsp;Log in at <a href="https://login.evil.example/x">www.bank.example</a>.</p>
</body></html>`;

interface Fixture {
  uid: number;
  messageId: string;
  subject: string;
  from: string;
  date: Date;
  seen: boolean;
  type: "text/html" | "text/plain" | "calendar";
  body: string;
}

const INBOX: Fixture[] = [
  { uid: 11, messageId: "<html@example.org>", subject: "Your invoice is ready", from: "billing@example.org", date: new Date(NOW - 3_600_000), seen: false, type: "text/html", body: HTML_ONLY },
  { uid: 12, messageId: "<invite@example.org>", subject: "Invitation: Planning", from: "olga@example.org", date: new Date(NOW - 7_200_000), seen: false, type: "calendar", body: ics("open-1", "REQUEST", "20261105T100000Z") },
  { uid: 13, messageId: "<answered@example.org>", subject: "Invitation: Review", from: "olga@example.org", date: new Date(NOW - 10_800_000), seen: false, type: "calendar", body: ics("answered-1", "REQUEST", "20261106T100000Z") },
  { uid: 14, messageId: "<over@example.org>", subject: "Invitation: Past", from: "olga@example.org", date: new Date(NOW - 14_400_000), seen: false, type: "calendar", body: ics("over-1", "REQUEST", "20261101T100000Z") },
  { uid: 15, messageId: "<older-open@example.org>", subject: "Invitation: Older", from: "olga@example.org", date: new Date(NOW - 5 * 86_400_000), seen: true, type: "calendar", body: ics("older-1", "REQUEST", "20261110T100000Z") },
  { uid: 16, messageId: "<older-plain@example.org>", subject: "Plain", from: "sam@example.org", date: new Date(NOW - 5 * 86_400_000), seen: true, type: "text/plain", body: "Hello,\n\nNothing here." },
];
const SENT: Fixture[] = [{ uid: 1, messageId: "<reply@example.com>", subject: "Accepted", from: "pat@example.com", date: new Date(NOW - 3_600_000), seen: true, type: "calendar", body: ics("answered-1", "REPLY", "20261106T100000Z", ["SEQUENCE:0"]) }];

const PROJECTS: Fixture[] = [{ uid: 15, messageId: "<project@example.org>", subject: "Project note", from: "sam@example.org", date: new Date(NOW - 3_600_000), seen: false, type: "text/plain", body: "Hello,\n\nA note." }];

const part = (f: Fixture) => ({ part: "1", type: f.type === "calendar" ? "text/calendar" : f.type });

function fixtureBox(): { box: ReadBox; reads: string[] } {
  const folders: Record<string, Fixture[]> = { INBOX, Sent: SENT, Projects: PROJECTS };
  const reads: string[] = [];
  let open = "";
  const current = (): Fixture[] => folders[open] ?? [];
  const box: ReadBox = {
    folders: async () => [{ path: "INBOX", name: "INBOX" }, { path: "Sent", name: "Sent", specialUse: "\\Sent" }],
    inFolder: async (path, work) => {
      const before = open;
      open = path;
      try {
        return await work();
      } finally {
        open = before;
      }
    },
    search: async (query, max) =>
      current()
        .filter((f) => ("unseen" in query ? !f.seen : f.date >= query.since))
        .map((f) => f.uid)
        .sort((a, b) => b - a)
        .slice(0, max),
    fetch: async (uids: number[], query: ReadQuery): Promise<ReadMessage[]> =>
      current()
        .filter((f) => uids.includes(f.uid))
        .map((f) => ({
          uid: f.uid,
          ...(query.bodyStructure ? { bodyStructure: part(f) } : {}),
          ...(query.envelope ? { envelope: { messageId: f.messageId, subject: f.subject, date: f.date, from: [{ address: f.from }] } } : {}),
          ...(query.flags ? { flags: new Set(f.seen ? ["\\Seen"] : []) } : {}),
          ...(query.internalDate ? { internalDate: f.date } : {}),
        })),
    text: async (uid) => {
      reads.push(`${open}:${uid}`);
      return current().find((f) => f.uid === uid)?.body ?? "";
    },
  };
  return { box, reads };
}

interface Derived {
  firstParagraph?: string;
  links?: DeskMailLink[];
  invitation?: DeskMailInvitation;
}

const derived = (items: DeskSourceMail[]): Map<string, Derived> =>
  new Map(items.map((i) => [i.id, { ...(i.firstParagraph ? { firstParagraph: i.firstParagraph } : {}), ...(i.links ? { links: i.links } : {}), ...(i.invitation ? { invitation: i.invitation } : {}) }]));

/** What desk-mail prints for the unread INBOX mail: `email get --html` for the paragraph, then readLinks, readInvitations and the look-back. */
async function viaDeskMail(box: ReadBox): Promise<DeskSourceMail[]> {
  const unread = INBOX.filter((f) => !f.seen);
  const run = async (args: string[]): Promise<string> => {
    const f = unread.find((m) => String(m.uid) === args[args.indexOf("-u") + 1]);
    if (!f) throw new Error("no such message");
    if (args.includes("--html")) return `━━━\nSubject\n━━━\n${f.type === "text/html" ? f.body : "(no body)"}`;
    return `━━━\nSubject\n━━━\n${f.type === "text/plain" ? f.body : "(no body)"}`;
  };
  const listed: EmailListEntry[] = unread.map((f) => ({ uid: f.uid, messageId: f.messageId, from: f.from, subject: f.subject, date: f.date.toISOString(), flags: [] }));
  const uids = listed.map((m) => m.uid);
  const links = await box.inFolder("INBOX", () => linksIn(box, uids));
  const invitations = await box.inFolder("INBOX", () => invitationsIn(box, uids, SELF));
  const lookback = await lookbackIn(box, { since: new Date(NOW - 14 * 86_400_000), scan: 200, skip: new Set(uids), self: SELF });
  const older = lookbackItems(lookback.candidates, { account: "work", listed: new Set(listed.map((m) => bareMessageId(m.messageId))), replies: lookback.replies, now: NOW, limit: 10 });
  const items: DeskSourceMail[] = [];
  for (const m of listed) {
    const paragraph = await readFirstParagraph(run, "work", m.uid, m.subject);
    const found = invitations.get(m.uid);
    const invitation = found && invitationOpen(found, lookback.replies, NOW) ? found : undefined;
    const l = links.get(m.uid);
    items.push({ ...emailToDeskMail(m, "work", paragraph), ...(l ? { links: l } : {}), ...(invitation ? { invitation } : {}) });
  }
  return [...items, ...older.map((o) => o.mail)];
}

const viaImap = (box: ReadBox, warn?: (line: string) => void): Promise<DeskSourceMail[]> =>
  readItems(box, { account: "work", mailbox: "INBOX", limit: 30, self: SELF, invite: { days: 14, scan: 200, limit: 10 }, now: NOW, ...(warn ? { warn } : {}) });

describe("desk-imap prints what desk-mail prints", () => {
  test("firstParagraph, links and invitation agree per Message-ID", async () => {
    const mail = derived(await viaDeskMail(fixtureBox().box));
    const imap = derived(await viaImap(fixtureBox().box));
    expect([...imap.keys()].sort()).toEqual([...mail.keys()].sort());
    for (const [id, expected] of mail) expect(imap.get(id)).toEqual(expected);
  });

  test("the fixture exercises each rule", async () => {
    const imap = derived(await viaImap(fixtureBox().box));
    expect(imap.get("html@example.org")).toEqual({
      firstParagraph: "The invoice for October is ready. Log in at www.bank.example.",
      links: [{ text: "www.bank.example", href: "https://login.evil.example/x" }],
    });
    expect(imap.get("invite@example.org")?.invitation?.uid).toBe("open-1");
    expect(imap.has("answered@example.org") && imap.get("answered@example.org")?.invitation).toBeFalsy();
    expect(imap.get("over@example.org")?.invitation).toBeUndefined();
    expect(imap.get("older-open@example.org")?.invitation?.uid).toBe("older-1");
    expect(imap.has("older-plain@example.org")).toBe(false);
  });

  test("a failed invitation read lists the mail without the field and warns", async () => {
    const { box } = fixtureBox();
    const failing: ReadBox = { ...box, text: async (uid, p, max) => { if (uid === 12) throw new Error("boom"); return box.text(uid, p, max); } };
    const lines: string[] = [];
    const items = derived(await viaImap(failing, (l) => lines.push(l)));
    expect(items.get("invite@example.org")?.invitation).toBeUndefined();
    expect(items.has("invite@example.org")).toBe(true);
    expect(lines.some((l) => l.includes("message 12"))).toBe(true);
  });

  test("an HTML-only message is downloaded once for its paragraph and its links", async () => {
    const { box, reads } = fixtureBox();
    await viaImap(box);
    expect(reads.filter((r) => r === "INBOX:11")).toHaveLength(1);
  });

  test("listing another mailbox does not hide an INBOX invitation with the same UID", async () => {
    const items = await readItems(fixtureBox().box, { account: "work", mailbox: "Projects", limit: 30, self: SELF, invite: { days: 14, scan: 200, limit: 10 }, now: NOW });
    expect(derived(items).get("older-open@example.org")?.invitation?.uid).toBe("older-1");
  });
});
