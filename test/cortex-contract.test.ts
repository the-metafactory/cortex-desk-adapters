import { expect, it } from "bun:test";
import { createCalendarEvent } from "../src/calendar-create";
import {
  MailDraftCommandRequestSchema,
  MailInvitationReplyCommandRequestSchema,
  MailLocateCommandRequestSchema,
  MailLocateCommandResultSchema,
  MailMoveCommandRequestSchema,
  MailMoveCommandResultSchema,
  MailReportCommandRequestSchema,
  MailRestoreCommandRequestSchema,
  SourceEventSchema,
  SourceMailSchema,
  SourceOutputSchema,
  WriterAnswer,
} from "../src/cortex-contract";
import { toDeskMail } from "../src/imap-mail";
import { locateMessage, moveMessage, readMoveRequest, type Mailbox } from "../src/move";
import { readDraftRequest } from "../src/draft";
import { readReportRequest } from "../src/report";
import type { DeskInviteReplyRequest } from "../src/cortex-contract";
import type { DeskSourceOutput } from "../src/contract";
import type { Runner } from "../src/run";

const ROOT = `${import.meta.dir}/..`;

it("source family: desk-ics prints output the SDK source schema accepts, event by event", async () => {
  const proc = Bun.spawn(["bun", `${ROOT}/bin/desk-ics.ts`, `${ROOT}/examples/calendar.ics`, "--days", "7"], { stdout: "pipe", stderr: "pipe" });
  const stdout = await new Response(proc.stdout).text();
  expect(await proc.exited).toBe(0);
  const raw = JSON.parse(stdout) as DeskSourceOutput;
  const output = SourceOutputSchema.parse(raw);
  const events = (output.events as unknown[]).map((e) => SourceEventSchema.parse(e));
  expect(events.length).toBeGreaterThan(0);
  expect(events.map((e) => e.id)).toEqual(raw.events!.map((e: { id: string }) => e.id));
});

it("source family: a mail item the IMAP source builds is accepted by the SDK mail schema, and a broken one is refused", () => {
  const date = new Date("2026-11-07T07:00:00Z");
  const item = toDeskMail({ messageId: "<m1@example.org>", subject: "Budget", date, from: [{ name: "Ada", address: "Ada@Example.org" }] }, "example", "Text", date);
  expect(SourceMailSchema.parse(item).id).toBe("m1@example.org");
  expect(SourceMailSchema.safeParse({ ...item, from: undefined }).success).toBe(false);
});

it("writer family: the calendar writer's answer is accepted by the SDK writer answer, and an answer without an id is refused", async () => {
  const run: Runner = async () => ({ code: 0, stdout: JSON.stringify({ id: "ev1", message: "Added." }), stderr: "" });
  const request = JSON.stringify({ kind: "calendar", fields: { title: "Probe", start: "2026-11-07T07:00:00Z" }, requestId: "req-00000001" });
  const result = await createCalendarEvent(request, { writer: "writer", reader: "reader", run });
  expect(WriterAnswer.parse(result)).toEqual(result);
  expect(WriterAnswer.safeParse({ message: "Added." }).success).toBe(false);
});

const FOLDERS = [
  { path: "INBOX", name: "INBOX", specialUse: "\\Inbox" },
  { path: "Archive", name: "Archive", specialUse: "\\Archive" },
];

function box(contents: Record<string, Record<number, string>>): Mailbox {
  let current = "";
  return {
    canMove: () => true,
    open: async (path) => { current = path; return () => {}; },
    findUids: async (id) => Object.entries(contents[current] ?? {}).filter(([, m]) => m.includes(id)).map(([uid]) => Number(uid)),
    messageIdOf: async (uid) => contents[current]?.[uid],
    unread: async () => true,
    folders: async () => FOLDERS,
    move: async () => true,
  };
}

it("mail action family: requests the commands read and results they print match the SDK schemas", async () => {
  const move = { action: "move" as const, account: "work", messageId: "a@x", target: "archive" as const };
  expect(MailMoveCommandRequestSchema.parse(readMoveRequest(JSON.stringify(move)))).toEqual(move);
  expect(MailMoveCommandRequestSchema.safeParse({ ...move, target: "elsewhere" }).success).toBe(false);

  const restore = { action: "restore" as const, account: "work", messageId: "a@x", from: "trash" as const };
  expect(MailRestoreCommandRequestSchema.parse(readMoveRequest(JSON.stringify(restore)))).toEqual(restore);
  const locate = { action: "locate" as const, account: "work", messageId: "a@x" };
  expect(MailLocateCommandRequestSchema.parse(readMoveRequest(JSON.stringify(locate)))).toEqual(locate);

  const moved = await moveMessage({ account: "work", messageId: "a@x", target: "archive" }, box({ INBOX: { 1: "<a@x>" } }));
  expect(MailMoveCommandResultSchema.parse(JSON.stringify(moved))).toEqual({ message: moved.message, folder: moved.folder });

  const located = await locateMessage({ account: "work", messageId: "a@x" }, box({ Archive: { 3: "<a@x>" } }));
  expect(MailLocateCommandResultSchema.parse(JSON.stringify(located))).toMatchObject({ place: located.place });
  expect(MailLocateCommandResultSchema.safeParse(JSON.stringify({ place: "nowhere" })).success).toBe(false);

  const draft = { action: "draft" as const, account: "work", messageId: "a@x", to: "ada@example.org", subject: "Re: Budget", body: "Thanks." };
  expect(MailDraftCommandRequestSchema.parse(readDraftRequest(JSON.stringify(draft)))).toEqual(draft);
  const report = { action: "report" as const, account: "work", messageId: "a@x", to: "abuse@example.org" };
  expect(MailReportCommandRequestSchema.parse(readReportRequest(JSON.stringify(report)))).toEqual(report);
  const invite: DeskInviteReplyRequest = { action: "invite-reply", account: "work", messageId: "a@x", uid: "u1", reply: "accept", requestId: "req-00000001" };
  expect(MailInvitationReplyCommandRequestSchema.parse(invite)).toEqual(invite);
});
