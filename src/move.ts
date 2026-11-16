import type { DeskMailLocateRequest, DeskMailMoveRequest, DeskMailRestoreRequest, DeskMoveTarget } from "./cortex-contract";
import type { DeskMailLocateResult, DeskMailMoveResult } from "./contract";
import { isRecord } from "./guards";
import { Refusal } from "./writers";

export interface Folder {
  path: string;
  name: string;
  specialUse?: string;
}

/** The few IMAP calls the move command makes, so tests never reach a mail server. */
export interface Mailbox {
  canMove(): boolean;
  open(path: string): Promise<() => void>;
  findUids(messageId: string): Promise<number[]>;
  messageIdOf(uid: number): Promise<string | undefined>;
  unread(uid: number): Promise<boolean>;
  folders(): Promise<Folder[]>;
  move(uid: number, target: string): Promise<boolean>;
}

export const MOVE_TARGETS: readonly DeskMoveTarget[] = ["archive", "junk", "trash"];

const TARGETS: Record<DeskMoveTarget, { flag: string; names: string[]; label: string }> = {
  archive: { flag: "\\Archive", names: ["Archive", "Archives"], label: "Archive" },
  junk: { flag: "\\Junk", names: ["Junk", "Junk E-Mail", "Junk Email", "Spam"], label: "Junk" },
  trash: { flag: "\\Trash", names: ["Trash", "Deleted Items", "Deleted Messages"], label: "Trash" },
};

const MESSAGE_ID = /^[^\s<>]{1,512}$/;
const ACCOUNT = /^[\w.-]{1,64}$/;

export const bareMessageId = (id: string): string => id.trim().replace(/^<|>$/g, "");

const isTarget = (v: unknown): v is DeskMoveTarget => MOVE_TARGETS.includes(v as DeskMoveTarget);

/** Picks the folder for a target: the one with its special-use flag, else one with a usual name. Never another target's folder. */
export const pickFolder = (boxes: Folder[], target: DeskMoveTarget): string | undefined => folderByUse(boxes, TARGETS[target].flag, TARGETS[target].names);

/** The folder with this special-use flag, else the first with one of these names (case-insensitive, name or path). */
export function folderByUse(boxes: Folder[], flag: string, names: readonly string[]): string | undefined {
  const flagged = boxes.find((b) => b.specialUse === flag);
  if (flagged) return flagged.path;
  for (const name of names) {
    const named = boxes.find((b) => b.name.toLowerCase() === name.toLowerCase() || b.path.toLowerCase() === name.toLowerCase());
    if (named) return named.path;
  }
  return undefined;
}

function parse(text: string): Record<string, unknown> {
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Refusal("The request is not valid JSON.");
  }
  if (!isRecord(body)) throw new Refusal("The request is not a JSON object.");
  return body;
}

function addressOf(body: Record<string, unknown>): { account: string; messageId: string } {
  const { account, messageId } = body;
  if (typeof account !== "string" || !ACCOUNT.test(account)) throw new Refusal("The request names no valid account.");
  if (typeof messageId !== "string" || !MESSAGE_ID.test(bareMessageId(messageId))) throw new Refusal("The request has no valid Message-ID.");
  return { account, messageId: bareMessageId(messageId) };
}

const trashFrom = (body: Record<string, unknown>): DeskMailMoveRequest => ({ action: "move", ...addressOf(body), target: "trash" });

/** Parses `{ action: "trash", account, messageId }`, refusing anything else. */
export function readTrashRequest(text: string): DeskMailMoveRequest {
  const body = parse(text);
  if (body.action !== "trash") throw new Refusal("This command only moves mail to Trash.");
  return trashFrom(body);
}

/**
 * Parses `{ action: "move", account, messageId, target }`, `{ action: "restore", account, messageId, from }` or
 * `{ action: "locate", account, messageId }`. A legacy `{ action: "trash", … }` reads as a move to Trash.
 */
export function readMoveRequest(text: string): DeskMailMoveRequest | DeskMailRestoreRequest | DeskMailLocateRequest {
  const body = parse(text);
  if (body.action === "trash") return trashFrom(body);
  if (body.action === "locate") return { action: "locate", ...addressOf(body) };
  if (body.action === "move") {
    if (!isTarget(body.target)) throw new Refusal("The request names no valid target: archive, junk or trash.");
    return { action: "move", ...addressOf(body), target: body.target };
  }
  if (body.action === "restore") {
    if (!isTarget(body.from)) throw new Refusal("The request names no valid folder to restore from: archive, junk or trash.");
    return { action: "restore", ...addressOf(body), from: body.from };
  }
  throw new Refusal("This command only moves mail, moves it back to the inbox, or locates it.");
}

async function exactUids(box: Mailbox, messageId: string): Promise<number[]> {
  const exact: number[] = [];
  for (const uid of await box.findUids(messageId)) {
    const id = await box.messageIdOf(uid);
    if (id !== undefined && bareMessageId(id) === messageId) exact.push(uid);
  }
  return exact;
}

async function onlyMessage(box: Mailbox, messageId: string, where: string): Promise<number> {
  const exact = await exactUids(box, messageId);
  const [uid, ...others] = exact;
  if (uid === undefined) throw new Refusal(`The message is no longer in the ${where}.`);
  if (others.length > 0) throw new Refusal(`${exact.length} messages in the ${where} share this Message-ID, so none was moved.`);
  return uid;
}

async function moveOne(box: Mailbox, account: string, from: string, to: string, messageId: string): Promise<void> {
  const release = await box.open(from);
  try {
    const uid = await onlyMessage(box, messageId, `${account} ${from}`);
    if (!(await box.move(uid, to))) throw new Refusal(`The mail server did not move the message to ${to}.`);
  } finally {
    release();
  }
}

async function folderFor(box: Mailbox, account: string, target: DeskMoveTarget): Promise<string> {
  if (!box.canMove()) throw new Refusal(`The ${account} mail server cannot move messages (no IMAP MOVE), so nothing was moved.`);
  const folder = pickFolder(await box.folders(), target);
  if (!folder) throw new Refusal(`The ${account} account has no ${TARGETS[target].label} mailbox, so nothing was moved.`);
  return folder;
}

/**
 * Moves the one inbox message with this Message-ID to the account's folder for the target, with IMAP MOVE.
 * Never deletes or expunges: it refuses a server without MOVE, an account without the target folder, and a
 * Message-ID that matches no message or more than one.
 */
export async function moveMessage(req: Omit<DeskMailMoveRequest, "action">, box: Mailbox, inbox = "INBOX"): Promise<DeskMailMoveResult> {
  const folder = await folderFor(box, req.account, req.target);
  await moveOne(box, req.account, inbox, folder, req.messageId);
  return { id: req.messageId, folder, message: `Moved to ${folder}.` };
}

/** Undoes a move: moves the one message with this Message-ID from the target's folder back to the inbox, under the same refusals. */
export async function restoreMessage(req: Omit<DeskMailRestoreRequest, "action">, box: Mailbox, inbox = "INBOX"): Promise<DeskMailMoveResult> {
  const folder = await folderFor(box, req.account, req.from);
  await moveOne(box, req.account, folder, inbox, req.messageId);
  return { id: req.messageId, folder: inbox, message: `Moved back to ${inbox} from ${folder}.` };
}

const PLACE_LABEL: Record<DeskMailLocateResult["place"], string> = { inbox: "the inbox", archive: "Archive", junk: "Junk", trash: "Trash", gone: "" };

/**
 * Finds where the message with this Message-ID is now: INBOX first, then the account's Archive, Junk and Trash folders.
 * Read-only. A message in none of them is `gone`; the command never guesses another folder.
 */
export async function locateMessage(req: Omit<DeskMailLocateRequest, "action">, box: Mailbox, inbox = "INBOX"): Promise<DeskMailLocateResult> {
  const boxes = await box.folders();
  const places: [DeskMailLocateResult["place"], string | undefined][] = [["inbox", inbox], ...MOVE_TARGETS.map((t): [DeskMoveTarget, string | undefined] => [t, pickFolder(boxes, t)])];
  for (const [place, folder] of places) {
    if (!folder) continue;
    const release = await box.open(folder);
    try {
      const [uid] = await exactUids(box, req.messageId);
      if (uid === undefined) continue;
      const unread = await box.unread(uid);
      return { id: req.messageId, place, folder, unread, message: `The message is in ${PLACE_LABEL[place]} (${folder}).` };
    } finally {
      release();
    }
  }
  return { id: req.messageId, place: "gone", message: `The message is not in the ${req.account} inbox, Archive, Junk or Trash.` };
}
