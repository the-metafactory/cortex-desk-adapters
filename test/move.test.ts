import { afterEach, beforeEach, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { imapAccount, resolvePassword } from "../src/imap-account";
import { locateMessage, moveMessage, pickFolder, readMoveRequest, readTrashRequest, restoreMessage, type Folder, type Mailbox } from "../src/move";
import type { Runner } from "../src/run";
import { Refusal } from "../src/writers";

const ID = "abc@gitlab.example";
const TRASH = { account: "work", messageId: ID, target: "trash" as const };
const ARCHIVE = { account: "work", messageId: ID, target: "archive" as const };

const FOLDERS: Folder[] = [
  { path: "INBOX", name: "INBOX", specialUse: "\\Inbox" },
  { path: "Archive", name: "Archive", specialUse: "\\Archive" },
  { path: "Junk", name: "Junk", specialUse: "\\Junk" },
  { path: "Trash", name: "Trash", specialUse: "\\Trash" },
];

function fakeBox(boxes: Record<string, Record<number, string>>, folders: Folder[] = FOLDERS, canMove = true, read: number[] = []) {
  const moved: { from: string; uid: number; target: string }[] = [];
  const opened: string[] = [];
  let current = "";
  let released = 0;
  const box: Mailbox = {
    canMove: () => canMove,
    open: async (path) => {
      opened.push(path);
      current = path;
      return () => { released += 1; };
    },
    findUids: async (id) => Object.entries(boxes[current] ?? {}).filter(([, m]) => m.includes(id)).map(([uid]) => Number(uid)),
    messageIdOf: async (uid) => boxes[current]?.[uid],
    unread: async (uid) => !read.includes(uid),
    folders: async () => folders,
    move: async (uid, target) => {
      moved.push({ from: current, uid, target });
      return true;
    },
  };
  return { box, moved, opened, released: () => released };
}

it("moves exactly the one INBOX message with that Message-ID to the target's folder, with a receipt naming it", async () => {
  const f = fakeBox({ INBOX: { 7: "<abc@gitlab.example>", 8: "<other@gitlab.example>", 9: "<xabc@gitlab.example.net>" } });
  expect(await moveMessage(ARCHIVE, f.box)).toEqual({ id: ID, folder: "Archive", message: "Moved to Archive." });
  expect(f.moved).toEqual([{ from: "INBOX", uid: 7, target: "Archive" }]);
  expect(await moveMessage({ ...ARCHIVE, target: "junk" }, fakeBox({ INBOX: { 7: `<${ID}>` } }).box)).toMatchObject({ folder: "Junk", message: "Moved to Junk." });
  expect(await moveMessage(TRASH, fakeBox({ INBOX: { 7: `<${ID}>` } }).box)).toEqual({ id: ID, folder: "Trash", message: "Moved to Trash." });
  expect(f.opened).toEqual(["INBOX"]);
  expect(f.released()).toBe(1);
});

it("undoes a move: the one message in the target's folder goes back to INBOX", async () => {
  const f = fakeBox({ INBOX: {}, Junk: { 3: `<${ID}>`, 4: "<other@x>" } });
  expect(await restoreMessage({ account: "work", messageId: ID, from: "junk" }, f.box)).toEqual({ id: ID, folder: "INBOX", message: "Moved back to INBOX from Junk." });
  expect(f.moved).toEqual([{ from: "Junk", uid: 3, target: "INBOX" }]);
  const gone = fakeBox({ Junk: {} });
  await expect(restoreMessage({ account: "work", messageId: ID, from: "junk" }, gone.box)).rejects.toThrow(new Refusal("The message is no longer in the work Junk."));
  expect(gone.moved).toEqual([]);
});

it("locates a mail read-only in INBOX, Archive, Junk or Trash, and reports gone instead of guessing", async () => {
  const req = { account: "work", messageId: ID };
  const inbox = fakeBox({ INBOX: { 5: `<${ID}>` } }, FOLDERS, true, [5]);
  expect(await locateMessage(req, inbox.box)).toMatchObject({ id: ID, place: "inbox", folder: "INBOX", unread: false });
  for (const [place, folder] of [["archive", "Archive"], ["junk", "Junk"], ["trash", "Trash"]] as const) {
    const f = fakeBox({ INBOX: { 1: "<other@x>" }, [folder]: { 9: `<${ID}>` } });
    expect(await locateMessage(req, f.box)).toMatchObject({ place, folder, unread: true });
    expect(f.moved).toEqual([]);
    expect(f.released()).toBe(f.opened.length);
  }
  const custom = fakeBox({ INBOX: {}, Archive: {}, Junk: {}, Trash: {}, Projects: { 2: `<${ID}>` } }, [...FOLDERS, { path: "Projects", name: "Projects" }]);
  expect(await locateMessage(req, custom.box)).toEqual({ id: ID, place: "gone", message: "The message is not in the work inbox, Archive, Junk or Trash." });
  expect(custom.opened).toEqual(["INBOX", "Archive", "Junk", "Trash"]);
  const noArchive = fakeBox({ INBOX: {}, Trash: {} }, [{ path: "INBOX", name: "INBOX" }, { path: "Trash", name: "Trash" }]);
  expect((await locateMessage(req, noArchive.box)).place).toBe("gone");
  expect(noArchive.opened).toEqual(["INBOX", "Trash"]);
  expect(readMoveRequest(JSON.stringify({ action: "locate", account: "work", messageId: `<${ID}>` }))).toEqual({ action: "locate", ...req });
});

it("refuses in one line when the message is gone, and moves nothing", async () => {
  const f = fakeBox({ INBOX: { 8: "<other@gitlab.example>" } });
  await expect(moveMessage(TRASH, f.box)).rejects.toThrow(new Refusal("The message is no longer in the work INBOX."));
  expect(f.moved).toEqual([]);
});

it("refuses when two messages share the Message-ID", async () => {
  const twice = fakeBox({ INBOX: { 1: "<abc@gitlab.example>", 2: "abc@gitlab.example" } });
  await expect(moveMessage(ARCHIVE, twice.box)).rejects.toThrow("2 messages in the work INBOX share this Message-ID, so none was moved.");
  expect(twice.moved).toEqual([]);
  const restore = fakeBox({ Archive: { 1: `<${ID}>`, 2: ID } });
  await expect(restoreMessage({ account: "work", messageId: ID, from: "archive" }, restore.box)).rejects.toThrow("2 messages in the work Archive share this Message-ID, so none was moved.");
  expect(restore.moved).toEqual([]);
});

it("refuses an account without the target's folder, naming account and target, and never falls back to another folder", async () => {
  const onlyTrash = fakeBox({ INBOX: { 1: `<${ID}>` } }, [{ path: "INBOX", name: "INBOX" }, { path: "Trash", name: "Trash", specialUse: "\\Trash" }]);
  await expect(moveMessage(ARCHIVE, onlyTrash.box)).rejects.toThrow("The work account has no Archive mailbox, so nothing was moved.");
  await expect(moveMessage({ ...ARCHIVE, target: "junk" }, onlyTrash.box)).rejects.toThrow("The work account has no Junk mailbox, so nothing was moved.");
  expect(onlyTrash.moved).toEqual([]);
  expect(onlyTrash.opened).toEqual([]);
});

it("refuses a server without IMAP MOVE before it opens a mailbox, so nothing is expunged", async () => {
  const f = fakeBox({ INBOX: { 7: `<${ID}>` } }, FOLDERS, false);
  await expect(moveMessage(TRASH, f.box)).rejects.toThrow("The work mail server cannot move messages (no IMAP MOVE), so nothing was moved.");
  await expect(restoreMessage({ account: "work", messageId: ID, from: "trash" }, f.box)).rejects.toThrow("(no IMAP MOVE)");
  expect(f.moved).toEqual([]);
  expect(f.opened).toEqual([]);
});

it("reads move, restore and the legacy trash request, refusing anything else", () => {
  expect(readMoveRequest(JSON.stringify({ action: "move", account: "work", messageId: `<${ID}>`, target: "archive" }))).toEqual({ action: "move", ...ARCHIVE });
  expect(readMoveRequest(JSON.stringify({ action: "restore", account: "work", messageId: ID, from: "junk" }))).toEqual({ action: "restore", account: "work", messageId: ID, from: "junk" });
  expect(readMoveRequest(JSON.stringify({ action: "trash", account: "work", messageId: ID }))).toEqual({ action: "move", ...TRASH });
  expect(() => readMoveRequest(JSON.stringify({ action: "move", account: "work", messageId: ID, target: "INBOX" }))).toThrow("The request names no valid target: archive, junk or trash.");
  expect(() => readMoveRequest(JSON.stringify({ action: "restore", account: "work", messageId: ID }))).toThrow("The request names no valid folder to restore from");
  expect(() => readMoveRequest(JSON.stringify({ action: "delete", account: "work", messageId: ID }))).toThrow("This command only moves mail, moves it back to the inbox, or locates it.");
  expect(() => readMoveRequest("[]")).toThrow("The request is not a JSON object.");
});

it("reads only a trash request with an account and a Message-ID on the legacy trash command", () => {
  expect(readTrashRequest(JSON.stringify({ action: "trash", account: "work", messageId: "<abc@gitlab.example>" }))).toEqual({ action: "move", ...TRASH });
  expect(() => readTrashRequest(JSON.stringify({ action: "move", account: "work", messageId: "a@b", target: "trash" }))).toThrow("This command only moves mail to Trash.");
  expect(() => readTrashRequest(JSON.stringify({ action: "trash", account: "../x", messageId: "a@b" }))).toThrow("The request names no valid account.");
  expect(() => readTrashRequest(JSON.stringify({ action: "trash", account: "work", messageId: "a b" }))).toThrow("The request has no valid Message-ID.");
  expect(() => readTrashRequest("not json")).toThrow("The request is not valid JSON.");
});

it("resolves each target by its special-use flag first, then by a usual name", () => {
  const exchange: Folder[] = [
    { path: "INBOX", name: "INBOX" }, { path: "Archiv", name: "Archiv", specialUse: "\\Archive" }, { path: "Archives", name: "Archives" },
    { path: "Archiv/Junk", name: "Junk", specialUse: "\\Junk" }, { path: "Junk Email", name: "Junk Email" }, { path: "Deleted Items", name: "Deleted Items", specialUse: "\\Trash" },
  ];
  expect([pickFolder(exchange, "archive"), pickFolder(exchange, "junk"), pickFolder(exchange, "trash")]).toEqual(["Archiv", "Archiv/Junk", "Deleted Items"]);
  const unflagged: Folder[] = [{ path: "INBOX", name: "INBOX" }, { path: "Archives", name: "Archives" }, { path: "Junk E-Mail", name: "Junk E-Mail" }, { path: "Deleted Items", name: "Deleted Items" }];
  expect([pickFolder(unflagged, "archive"), pickFolder(unflagged, "junk"), pickFolder(unflagged, "trash")]).toEqual(["Archives", "Junk E-Mail", "Deleted Items"]);
  const gmailish: Folder[] = [{ path: "INBOX", name: "INBOX" }, { path: "Spam", name: "Spam" }, { path: "Papierkorb", name: "Papierkorb", specialUse: "\\Trash" }, { path: "Trash", name: "Trash" }];
  expect([pickFolder(gmailish, "archive"), pickFolder(gmailish, "junk"), pickFolder(gmailish, "trash")]).toEqual([undefined, "Spam", "Papierkorb"]);
});

let dir = "";
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "desk-mail-trash-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const keychain = (pass: string, code = 0) => {
  const calls: string[][] = [];
  const run: Runner = async (argv) => {
    calls.push(argv);
    return { code, stdout: `${pass}\n`, stderr: "" };
  };
  return { run, calls };
};

it("reads the account from the email config, case-insensitively, with the password from the keychain", async () => {
  const path = join(dir, "config.json");
  writeFileSync(path, JSON.stringify({ accounts: { Work: { smtp: { auth: { user: "ada", pass: "keychain:mail-work" } }, imap: { enabled: true, host: "imap.example", port: 993, tls: true } } } }));
  const k = keychain("s3cret");
  expect(await imapAccount("work", k.run, path)).toEqual({ name: "work", host: "imap.example", port: 993, secure: true, user: "ada", pass: "s3cret" });
  expect(k.calls).toEqual([["security", "find-generic-password", "-s", "mail-work", "-w"]]);
});

it("refuses an unknown account, one without IMAP, and a missing keychain item", async () => {
  const path = join(dir, "config.json");
  writeFileSync(path, JSON.stringify({ accounts: { work: { smtp: { auth: { user: "ada", pass: "x" } } } } }));
  await expect(imapAccount("home", keychain("x").run, path)).rejects.toThrow("There is no home account in the mail config.");
  await expect(imapAccount("work", keychain("x").run, path)).rejects.toThrow("The work account has no IMAP settings.");
  await expect(resolvePassword("keychain:nope", keychain("", 44).run)).rejects.toThrow("The mail password could not be read from the keychain.");
  expect(await resolvePassword("env:MAIL_PASS", keychain("x").run, { MAIL_PASS: "p" })).toBe("p");
});
