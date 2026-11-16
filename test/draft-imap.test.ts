import { expect, it } from "bun:test";
import { readDraftRequest, saveDraftImap, type DraftBox } from "../src/draft";
import { Refusal } from "../src/writers";

const REQ = { action: "draft", account: "work", messageId: "<b1@example.org>", to: "boss@example.org", subject: "Re: Büdget", body: "Friday works.\n\nJC ü" };

function fakeBox(folders: { path: string; name: string; specialUse?: string }[]) {
  const appended: { folder: string; content: string; flags: string[] }[] = [];
  const box: DraftBox = {
    folders: async () => folders,
    append: async (folder, content, flags) => void appended.push({ folder, content: Buffer.from(content).toString("utf8"), flags }),
  };
  return { box, appended };
}

it("appends one threaded UTF-8 draft with \\Draft to the \\Drafts folder and returns its Message-ID", async () => {
  const f = fakeBox([{ path: "INBOX", name: "INBOX" }, { path: "Entwuerfe", name: "Entwuerfe", specialUse: "\\Drafts" }]);
  const result = await saveDraftImap(readDraftRequest(JSON.stringify(REQ)), f.box, { from: "me@example.org", newId: () => "x1", now: () => new Date("2026-01-02T03:04:05Z") });
  expect(result.id).toBe("desk-draft-x1@desk.invalid");
  expect(f.appended).toHaveLength(1);
  const { folder, content, flags } = f.appended[0]!;
  expect(folder).toBe("Entwuerfe");
  expect(flags).toEqual(["\\Draft"]);
  expect(content).toContain("From: me@example.org\r\n");
  expect(content).toContain("To: boss@example.org\r\n");
  expect(content).toContain("In-Reply-To: <b1@example.org>\r\n");
  expect(content).toContain("References: <b1@example.org>\r\n");
  expect(content).toContain("Message-ID: <desk-draft-x1@desk.invalid>\r\n");
  expect(content).toContain("Content-Type: text/plain; charset=UTF-8");
  const subject = /Subject: =\?UTF-8\?B\?(.+)\?=/.exec(content)![1]!;
  expect(Buffer.from(subject, "base64").toString("utf8")).toBe("Re: Büdget");
  const body = content.split("\r\n\r\n")[1]!.replace(/\r\n/g, "");
  expect(Buffer.from(body, "base64").toString("utf8")).toBe("Friday works.\r\n\r\nJC ü");
});

it("falls back to a usual Drafts name", async () => {
  const f = fakeBox([{ path: "Drafts", name: "Drafts" }]);
  await saveDraftImap(readDraftRequest(JSON.stringify(REQ)), f.box, { from: "me@example.org" });
  expect(f.appended[0]!.folder).toBe("Drafts");
});

it("refuses in one sentence and saves nothing when the account has no Drafts folder", async () => {
  const f = fakeBox([{ path: "INBOX", name: "INBOX" }]);
  const err = await saveDraftImap(readDraftRequest(JSON.stringify(REQ)), f.box, { from: "me@example.org" }).catch((e: unknown) => e);
  expect(err).toBeInstanceOf(Refusal);
  expect((err as Error).message).toBe("The work account has no Drafts mailbox, so no draft was saved.");
  expect(f.appended).toEqual([]);
});

it("keeps the shared refusals on this route", () => {
  for (const bad of [{ to: "a@b.c, d@e.f" }, { to: "Name <a@b.c>" }, { subject: "a\nb" }, { body: "  " }]) {
    expect(() => readDraftRequest(JSON.stringify({ ...REQ, ...bad }))).toThrow(Refusal);
  }
});
