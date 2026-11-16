import { ImapFlow } from "imapflow";
import type { ImapAccount } from "./imap-account";
import { imapAccount } from "./imap-account";
import type { DeskMailHeaders, DeskMailInvitation, DeskMailLink, DeskSourceMail, DeskSourceSentMail } from "./contract";
import { firstParagraphOfHtmlBody } from "./mail";
import { calendarPart, parseInvitation, parseReply, type CalendarPartNode } from "./invitation";
import { addReply, invitationOpen, lookbackItems, type LookbackCandidate } from "./invitation-lookback";
import { linksOf } from "./links";
import { MAX_ORIGINAL, TOO_LARGE, type PhishingReportBox } from "./report";
import { HEADER_FIELDS, headersOf, messageIds } from "./mail-headers";
import { ReportRefusal, type Attachment, type ReportMailbox } from "./dmarc";
import { bareMessageId, folderByUse, type Mailbox } from "./move";
import { firstParagraph, textPart, toDeskMail, type StructureNode } from "./imap-mail";
import { ARCHIVE_NAMES, replyCandidate, sentFolders, sentText, toSentMail, withReplies, type ReplyCandidate, type SentEnvelope } from "./sent";
import { spawnRunner } from "./run";
import { Refusal } from "./writers";

/** A Mailbox over one ImapFlow connection; the caller connects and logs out. */
export function imapMailbox(client: ImapFlow): Mailbox {
  return {
    canMove: () => client.capabilities.has("MOVE"),
    open: async (path) => {
      const lock = await client.getMailboxLock(path);
      return () => lock.release();
    },
    findUids: async (messageId) => (await client.search({ header: { "message-id": messageId } }, { uid: true })) || [],
    messageIdOf: async (uid) => {
      const [m] = await client.fetchAll([uid], { envelope: true }, { uid: true });
      return m?.envelope?.messageId;
    },
    unread: async (uid) => {
      const [m] = await client.fetchAll([uid], { flags: true }, { uid: true });
      return !(m?.flags?.has("\\Seen") ?? false);
    },
    folders: async () => (await client.list()).map((b) => ({ path: b.path, name: b.name, ...(b.specialUse ? { specialUse: b.specialUse } : {}) })),
    move: async (uid, target) => Boolean(await client.messageMove([uid], target, { uid: true })),
  };
}

export interface ReadMessage {
  uid: number;
  bodyStructure?: unknown;
  envelope?: SentEnvelope;
  flags?: Set<string>;
  internalDate?: Date | string;
  headers?: Buffer;
}

export interface ReadQuery {
  bodyStructure?: boolean;
  envelope?: boolean;
  flags?: boolean;
  internalDate?: boolean;
  headers?: string[];
}

/** The read-only side of a connected mailbox: what the item builders need, and what a fixture mailbox implements. */
export interface ReadBox {
  folders(): Promise<{ path: string; name: string; specialUse?: string }[]>;
  /** Runs `work` with the folder open read-only (EXAMINE). */
  inFolder<T>(path: string, work: () => Promise<T>): Promise<T>;
  /** The UIDs of the open folder, newest first: those since a date, or the unseen ones, at most `max`. */
  search(query: { since: Date } | { unseen: true }, max: number): Promise<number[]>;
  fetch(uids: number[], query: ReadQuery): Promise<ReadMessage[]>;
  /** One body part, read with BODY.PEEK, at most `maxBytes`. */
  text(uid: number, part: string, maxBytes: number): Promise<string>;
}

export function imapReadBox(client: ImapFlow): ReadBox {
  return {
    folders: async () => (await client.list()).map((b) => ({ path: b.path, name: b.name, ...(b.specialUse ? { specialUse: b.specialUse } : {}) })),
    inFolder: async (path, work) => {
      const lock = await client.getMailboxLock(path, { readOnly: true });
      try {
        return await work();
      } finally {
        lock.release();
      }
    },
    search: async (query, max) => ((await client.search("since" in query ? { since: query.since } : { seen: false }, { uid: true })) || []).sort((a, b) => b - a).slice(0, max),
    fetch: async (uids, query) => (await client.fetchAll(uids, query, { uid: true })) as unknown as ReadMessage[],
    text: async (uid, part, maxBytes) => {
      const { content } = await client.download(String(uid), part, { uid: true, maxBytes });
      const chunks: Buffer[] = [];
      for await (const chunk of content) chunks.push(Buffer.from(chunk));
      return Buffer.concat(chunks).toString("utf8");
    },
  };
}

export function connectImap(account: ImapAccount): ImapFlow {
  return new ImapFlow({
    host: account.host,
    port: account.port,
    secure: account.secure,
    ...(account.secure ? {} : { doSTARTTLS: true }),
    auth: { user: account.user, pass: account.pass },
    logger: false,
  });
}

async function withImapClient<T>(account: string, work: (client: ImapFlow) => Promise<T>, configPath?: string): Promise<T> {
  const client = connectImap(await imapAccount(account, spawnRunner, configPath));
  client.on("error", () => undefined);
  try {
    await client.connect();
  } catch {
    throw new Refusal(`The ${account} mail server did not accept the connection.`);
  }
  try {
    return await work(client);
  } finally {
    await client.logout().catch(() => undefined);
  }
}

/** Connects to one account from the selected mail config, runs `work` on its mailbox, and always logs out. */
export const withMailbox = <T>(account: string, work: (box: Mailbox) => Promise<T>, configPath?: string): Promise<T> => withImapClient(account, (client) => work(imapMailbox(client)), configPath);

export interface MailboxOptions {
  mailbox?: string;
  configPath?: string;
}

export interface HeadersOptions extends MailboxOptions {
  trustedAuthserv?: readonly string[];
}

/** Reads the Desk's header fields for these INBOX UIDs, read-only (BODY.PEEK), so no message is marked read. */
export async function readHeaders(account: string, uids: number[], { trustedAuthserv = [], mailbox = "INBOX", configPath }: HeadersOptions = {}): Promise<Map<number, DeskMailHeaders>> {
  const out = new Map<number, DeskMailHeaders>();
  if (uids.length === 0) return out;
  return withImapClient(account, async (client) => {
    const lock = await client.getMailboxLock(mailbox, { readOnly: true });
    try {
      for (const m of await client.fetchAll(uids, { headers: HEADER_FIELDS }, { uid: true })) {
        const headers = headersOf(m, trustedAuthserv);
        if (headers) out.set(m.uid, headers);
      }
    } finally {
      lock.release();
    }
    return out;
  }, configPath);
}

interface Part {
  part?: string;
  type?: string;
  size?: number;
  parameters?: Record<string, string>;
  dispositionParameters?: Record<string, string>;
  childNodes?: Part[];
}

const leaves = (n: Part | undefined): Part[] => (!n ? [] : n.childNodes?.length ? n.childNodes.flatMap(leaves) : [n]);

/** The attachments of one message's body structure: media type, file name and encoded size. A single-part message is part 1. */
export const attachmentsOf = (structure: Part | undefined): (Attachment & { part: string })[] =>
  leaves(structure).map((p) => ({
    part: p.part ?? "1",
    type: (p.type ?? "").toLowerCase(),
    filename: p.dispositionParameters?.filename ?? p.parameters?.name ?? "",
    size: p.size ?? 0,
  }));

/**
 * A read-only ReportMailbox over one account's INBOX: the mailbox is opened with EXAMINE and parts are fetched with
 * BODY.PEEK, so the mail is never marked read. It refuses a Message-ID that matches no message or more than one.
 */
export async function withReportMailbox<T>(account: string, work: (box: ReportMailbox) => Promise<T>, { mailbox = "INBOX", configPath }: MailboxOptions = {}): Promise<T> {
  return withImapClient(account, async (client) => {
    const lock = await client.getMailboxLock(mailbox, { readOnly: true });
    try {
      const uids = new Map<string, Promise<number>>();
      const findUid = async (messageId: string): Promise<number> => {
        const found = (await client.search({ header: { "message-id": messageId } }, { uid: true })) || [];
        const exact = found.length ? (await client.fetchAll(found, { envelope: true }, { uid: true })).filter((m) => bareMessageId(m.envelope?.messageId ?? "") === messageId) : [];
        const [only, ...others] = exact;
        if (!only) throw new Refusal(`The message is no longer in the ${account} ${mailbox}.`);
        if (others.length > 0) throw new ReportRefusal(`${exact.length} messages in the ${account} ${mailbox} share this Message-ID, so none was read.`);
        return only.uid;
      };
      const uidOf = (messageId: string): Promise<number> => {
        const known = uids.get(messageId) ?? findUid(messageId);
        uids.set(messageId, known);
        return known;
      };
      return await work({
        attachments: async (messageId) => {
          const [m] = await client.fetchAll([await uidOf(messageId)], { bodyStructure: true }, { uid: true });
          return attachmentsOf(m?.bodyStructure as Part | undefined);
        },
        download: async (messageId, part, maxBytes) => {
          const { content } = await client.download(String(await uidOf(messageId)), part, { uid: true, maxBytes });
          const chunks: Buffer[] = [];
          for await (const chunk of content) chunks.push(chunk as Buffer);
          return new Uint8Array(Buffer.concat(chunks));
        },
      });
    } finally {
      lock.release();
    }
  }, configPath);
}

export const htmlPart = (structure: Part | undefined): string | undefined => {
  const html = leaves(structure).find((p) => (p.type ?? "").toLowerCase() === "text/html" && !p.dispositionParameters?.filename);
  return html ? html.part ?? "1" : undefined;
};

export interface LinksOptions extends MailboxOptions {
  warn?: (line: string) => void;
  maxBytes?: number;
}

/** The links of each message's HTML body, for these UIDs of the open folder, read with BODY.PEEK, so no message is marked read. */
export async function linksIn(box: ReadBox, uids: number[], { warn = () => undefined, maxBytes = 256 * 1024, htmlByUid }: { warn?: (line: string) => void; maxBytes?: number; htmlByUid?: ReadonlyMap<number, string> } = {}): Promise<Map<number, DeskMailLink[]>> {
  const out = new Map<number, DeskMailLink[]>();
  if (uids.length === 0) return out;
  for (const m of await box.fetch(uids, { bodyStructure: true })) {
    const part = htmlPart(m.bodyStructure as Part | undefined);
    if (!part) continue;
    try {
      const links = linksOf(htmlByUid?.get(m.uid) ?? await box.text(m.uid, part, maxBytes));
      if (links.length > 0) out.set(m.uid, links);
    } catch (err) {
      warn(`the links of message ${m.uid} were not read: ${errorText(err)}`);
    }
  }
  return out;
}

/** The links of each message's HTML body, for these INBOX UIDs, read-only (EXAMINE, BODY.PEEK), so no message is marked read. */
export async function readLinks(account: string, uids: number[], { warn = () => undefined, mailbox = "INBOX", maxBytes = 256 * 1024, configPath }: LinksOptions = {}): Promise<Map<number, DeskMailLink[]>> {
  if (uids.length === 0) return new Map();
  return withImapClient(account, (client) => {
    const box = imapReadBox(client);
    return box.inFolder(mailbox, () => linksIn(box, uids, { warn, maxBytes }));
  }, configPath);
}

async function findOriginal(client: ImapFlow, account: string, folder: string, messageId: string): Promise<Uint8Array | undefined> {
  const lock = await client.getMailboxLock(folder, { readOnly: true });
  try {
    const found = (await client.search({ header: { "message-id": messageId } }, { uid: true })) || [];
    if (found.length === 0) return undefined;
    const exact = (await client.fetchAll(found, { envelope: true, size: true }, { uid: true })).filter((m) => bareMessageId(m.envelope?.messageId ?? "") === messageId);
    const [only, ...others] = exact;
    if (!only) return undefined;
    if (others.length > 0) throw new Refusal(`${exact.length} messages in the ${account} ${folder} share this Message-ID, so none was reported.`);
    if ((only.size ?? 0) > MAX_ORIGINAL) throw new Refusal(TOO_LARGE);
    const message = await client.fetchOne(String(only.uid), { source: true }, { uid: true });
    return message && message.source ? new Uint8Array(message.source) : undefined;
  } finally {
    lock.release();
  }
}

/**
 * A PhishingReportBox over one connected client. The draft is appended while its folder is selected read-write: imapflow
 * keeps only the flags the selected mailbox allows, and a mailbox left selected read-only allows none, so \Draft would be lost.
 */
export const phishingReportBox = (client: ImapFlow, account: string): PhishingReportBox => ({
  folders: async () => (await client.list()).map((b) => ({ path: b.path, name: b.name, ...(b.specialUse ? { specialUse: b.specialUse } : {}) })),
  source: (folder, messageId) => findOriginal(client, account, folder, messageId),
  append: async (folder, content, flags) => {
    const lock = await client.getMailboxLock(folder);
    try {
      const done = await client.append(folder, Buffer.from(content), flags);
      if (!done) throw new Refusal(`The ${account} mail server did not save the report draft.`);
    } finally {
      lock.release();
    }
  },
});

/** Runs `work` on a PhishingReportBox for one account: originals are read with EXAMINE and BODY.PEEK; the draft goes to Drafts. */
export function withPhishingReportBox<T>(account: string, work: (box: PhishingReportBox, user: string) => Promise<T>, configPath?: string): Promise<T> {
  return imapAccount(account, spawnRunner, configPath).then((acct) => withImapClient(account, (client) => work(phishingReportBox(client, account), acct.user), configPath));
}

export interface SentOptions {
  days: number;
  limit: number;
  now?: number;
  warn?: (line: string) => void;
}

const DAY_MS = 86_400_000;

export const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));
const MAX_CANDIDATES = 1000;
const TEXT_BYTES = 8192;

const referencesOf = (m: { headers?: Buffer }): string[] => messageIds(m.headers?.toString("utf8"));

async function newestUids(client: ImapFlow, since: Date, max: number): Promise<number[]> {
  return ((await client.search({ since }, { uid: true })) || []).sort((a, b) => b - a).slice(0, max);
}

async function inFolder<T>(client: ImapFlow, path: string, work: () => Promise<T>): Promise<T> {
  const lock = await client.getMailboxLock(path, { readOnly: true });
  try {
    return await work();
  } finally {
    lock.release();
  }
}

async function sentBody(client: ImapFlow, uid: number, structure: StructureNode | undefined): Promise<string | undefined> {
  const part = textPart(structure);
  if (!part) return undefined;
  const { content } = await client.download(String(uid), part, { uid: true, maxBytes: TEXT_BYTES });
  const chunks: Buffer[] = [];
  for await (const chunk of content) chunks.push(Buffer.from(chunk));
  return sentText(Buffer.concat(chunks).toString("utf8"));
}

interface Listed {
  path: string;
  uid: number;
  structure: StructureNode | undefined;
  item: DeskSourceSentMail;
}

const sentIn = (client: ImapFlow, path: string, since: Date, limit: number, account: string): Promise<Listed[]> =>
  inFolder(client, path, async () => {
    const uids = await newestUids(client, since, limit);
    if (uids.length === 0) return [];
    const messages = await client.fetchAll(uids, { envelope: true, bodyStructure: true, headers: ["references"] }, { uid: true });
    return messages.flatMap((m) => {
      const item = m.envelope ? toSentMail(m.envelope, account, referencesOf(m)) : null;
      return item ? [{ path, uid: m.uid, structure: m.bodyStructure as StructureNode | undefined, item }] : [];
    });
  });

const candidatesIn = (client: ImapFlow, path: string, since: Date): Promise<ReplyCandidate[]> =>
  inFolder(client, path, async () => {
    const uids = await newestUids(client, since, MAX_CANDIDATES);
    if (uids.length === 0) return [];
    const messages = await client.fetchAll(uids, { envelope: true, headers: ["references"] }, { uid: true });
    return messages.flatMap((m) => (m.envelope ? replyCandidate(m.envelope, referencesOf(m)) ?? [] : []));
  });

/**
 * The account's sent mail of the last `days` days (newest `limit`), read-only (EXAMINE, BODY.PEEK), each with the
 * replies found in INBOX and the archive folder. Sent folders that cannot be read are skipped with a warning. When a
 * reply folder cannot be read it lists no sent mail at all, so answered mail never looks unanswered.
 */
export async function readSent(account: string, options: SentOptions, configPath?: string): Promise<DeskSourceSentMail[]> {
  const warn = options.warn ?? (() => undefined);
  const since = new Date((options.now ?? Date.now()) - options.days * DAY_MS);
  return withImapClient(account, async (client) => {
    const boxes = (await client.list()).map((b) => ({ path: b.path, name: b.name, ...(b.specialUse ? { specialUse: b.specialUse } : {}) }));
    const sentPaths = sentFolders(boxes);
    if (sentPaths.length === 0) {
      warn("no Sent folder was found, so sent mail is not listed");
      return [];
    }
    const listed: Listed[] = [];
    for (const path of sentPaths) {
      try {
        listed.push(...(await sentIn(client, path, since, options.limit, account)));
      } catch (err) {
        warn(`sent mail in ${path} was not read: ${errorText(err)}`);
      }
    }
    const byId = new Map<string, Listed>();
    for (const l of listed) if (!byId.has(l.item.id)) byId.set(l.item.id, l);
    const newest = [...byId.values()].sort((a, b) => Date.parse(b.item.sentAt) - Date.parse(a.item.sentAt)).slice(0, options.limit);
    if (newest.length === 0) return [];
    const archivePath = folderByUse(boxes, "\\Archive", ARCHIVE_NAMES);
    if (!archivePath) warn("no archive folder was found, so replies are looked for in INBOX only");
    const candidates: ReplyCandidate[] = [];
    for (const folder of ["INBOX", ...(archivePath ? [archivePath] : [])]) {
      try {
        candidates.push(...(await candidatesIn(client, folder, since)));
      } catch (err) {
        warn(`replies in ${folder} were not read, so sent mail is not listed: ${errorText(err)}`);
        return [];
      }
    }
    const sent: DeskSourceSentMail[] = [];
    for (const path of new Set(newest.map((l) => l.path))) {
      await inFolder(client, path, async () => {
        for (const l of newest.filter((x) => x.path === path)) {
          const text = await sentBody(client, l.uid, l.structure).catch(() => undefined);
          sent.push(withReplies(text ? { ...l.item, text } : l.item, candidates));
        }
      }).catch((err: unknown) => {
        warn(`the text of sent mail in ${path} was not read: ${errorText(err)}`);
        for (const l of newest.filter((x) => x.path === path)) sent.push(withReplies(l.item, candidates));
      });
    }
    return sent.sort((a, b) => Date.parse(b.sentAt) - Date.parse(a.sentAt));
  }, configPath);
}

const CALENDAR_BYTES = 256 * 1024;

async function downloadText(client: ImapFlow, uid: number, part: string, maxBytes: number): Promise<string> {
  const { content } = await client.download(String(uid), part, { uid: true, maxBytes });
  const chunks: Buffer[] = [];
  for await (const chunk of content) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

export interface InvitationOptions extends MailboxOptions {
  warn?: (line: string) => void;
}

/** The calendar invitations of these UIDs of the open folder, read with BODY.PEEK, so no message is marked read. */
export async function invitationsIn(box: ReadBox, uids: number[], self: readonly string[], { warn = () => undefined }: { warn?: (line: string) => void } = {}): Promise<Map<number, DeskMailInvitation>> {
  const out = new Map<number, DeskMailInvitation>();
  if (uids.length === 0) return out;
  for (const m of await box.fetch(uids, { bodyStructure: true })) {
    const part = calendarPart(m.bodyStructure as CalendarPartNode | undefined);
    if (!part) continue;
    try {
      const invitation = parseInvitation(await box.text(m.uid, part, CALENDAR_BYTES), self);
      if (invitation) out.set(m.uid, invitation);
    } catch (err) {
      warn(`the invitation of message ${m.uid} was not read: ${errorText(err)}`);
    }
  }
  return out;
}

/** The calendar invitations of these INBOX UIDs, read-only (EXAMINE, BODY.PEEK), so no message is marked read. */
export async function readInvitations(account: string, uids: number[], self: readonly string[], { warn = () => undefined, mailbox = "INBOX", configPath }: InvitationOptions = {}): Promise<Map<number, DeskMailInvitation>> {
  if (uids.length === 0) return new Map();
  return withImapClient(account, (client) => {
    const box = imapReadBox(client);
    return box.inFolder(mailbox, () => invitationsIn(box, uids, self, { warn }));
  }, configPath);
}

interface CalendarText {
  uid: number;
  ics: string;
  envelope?: SentEnvelope;
  flags?: Set<string>;
}

async function calendarTexts(box: ReadBox, uids: number[], warn: (line: string) => void, query: { envelope?: boolean; flags?: boolean } = {}): Promise<CalendarText[]> {
  if (uids.length === 0) return [];
  const out: CalendarText[] = [];
  for (const m of await box.fetch(uids, { bodyStructure: true, ...query })) {
    const part = calendarPart(m.bodyStructure as CalendarPartNode | undefined);
    if (!part) continue;
    try {
      out.push({ uid: m.uid, ics: await box.text(m.uid, part, CALENDAR_BYTES), ...(m.envelope ? { envelope: m.envelope } : {}), ...(m.flags ? { flags: m.flags } : {}) });
    } catch (err) {
      warn(`the calendar part of message ${m.uid} was not read: ${errorText(err)}`);
    }
  }
  return out;
}

export interface LookbackOptions {
  since: Date;
  /** At most this many newest messages are scanned, in INBOX and in each Sent folder. */
  scan: number;
  /** INBOX UIDs already listed, which the look-back skips. */
  skip: ReadonlySet<number>;
  self: readonly string[];
  warn?: (line: string) => void;
}

/**
 * One read-only pass (EXAMINE, BODY.PEEK) for the invitation look-back: the iTIP REPLYs the account sent since `since`
 * (from its Sent folders), and the INBOX invitations since `since` that are not in `skip`. A Sent folder that cannot be
 * read is skipped with a warning, so an invitation answered there may still show.
 */
export async function lookbackIn(box: ReadBox, options: LookbackOptions): Promise<{ replies: Map<string, number>; candidates: LookbackCandidate[] }> {
  const warn = options.warn ?? (() => undefined);
  const replies = new Map<string, number>();
  const sentPaths = sentFolders(await box.folders());
  if (sentPaths.length === 0) warn("no Sent folder was found, so invitations answered outside the Desk are not recognised");
  for (const path of sentPaths) {
    try {
      await box.inFolder(path, async () => {
        for (const { ics } of await calendarTexts(box, await box.search({ since: options.since }, options.scan), warn)) {
          const reply = parseReply(ics);
          if (reply) addReply(replies, reply);
        }
      });
    } catch (err) {
      warn(`invitation replies in ${path} were not read: ${errorText(err)}`);
    }
  }
  const candidates = await box.inFolder("INBOX", async () => {
    const uids = (await box.search({ since: options.since }, options.scan)).filter((uid) => !options.skip.has(uid));
    return (await calendarTexts(box, uids, warn, { envelope: true, flags: true })).flatMap((m): LookbackCandidate[] => {
      const invitation = m.envelope ? parseInvitation(m.ics, options.self) : null;
      return invitation && m.envelope ? [{ uid: m.uid, envelope: m.envelope, flags: m.flags, invitation }] : [];
    });
  });
  return { replies, candidates };
}

export const readLookback = (account: string, options: LookbackOptions, configPath?: string): Promise<{ replies: Map<string, number>; candidates: LookbackCandidate[] }> =>
  withImapClient(account, (client) => lookbackIn(imapReadBox(client), options), configPath);

/** The text/calendar part of the one INBOX message with this Message-ID, read-only; undefined when it carries none. */
export async function invitationSource(account: string, messageId: string, mailbox = "INBOX", configPath?: string): Promise<string | undefined> {
  return withImapClient(account, async (client) => {
    const lock = await client.getMailboxLock(mailbox, { readOnly: true });
    try {
      const found = (await client.search({ header: { "message-id": messageId } }, { uid: true })) || [];
      const exact = found.length ? (await client.fetchAll(found, { envelope: true, bodyStructure: true }, { uid: true })).filter((m) => bareMessageId(m.envelope?.messageId ?? "") === messageId) : [];
      const [only, ...others] = exact;
      if (!only) throw new Refusal(`The invitation is no longer in the ${account} ${mailbox}.`);
      if (others.length > 0) throw new Refusal(`${exact.length} messages in the ${account} ${mailbox} share this Message-ID, so none was answered.`);
      const part = calendarPart(only.bodyStructure as CalendarPartNode | undefined);
      return part ? await downloadText(client, only.uid, part, CALENDAR_BYTES) : undefined;
    } finally {
      lock.release();
    }
  }, configPath);
}

export interface ItemsInput {
  account: string;
  mailbox: string;
  limit: number;
  /** The account's own addresses, for the invitation's attendee. */
  self: readonly string[];
  authserv?: readonly string[];
  invite: { days: number; scan: number; limit: number };
  now?: number;
  warn?: (line: string) => void;
}

const LIST_TEXT_BYTES = 16_384;
const LIST_HTML_BYTES = 256 * 1024;

async function paragraphOf(box: ReadBox, m: ReadMessage, htmlByUid: Map<number, string>): Promise<string | undefined> {
  const structure = m.bodyStructure as StructureNode & Part | undefined;
  const plain = textPart(structure);
  if (plain) return firstParagraph(await box.text(m.uid, plain, LIST_TEXT_BYTES));
  const html = htmlPart(structure);
  if (!html) return undefined;
  const body = await box.text(m.uid, html, LIST_HTML_BYTES);
  htmlByUid.set(m.uid, body);
  return firstParagraphOfHtmlBody(body, m.envelope?.subject);
}

/**
 * The Desk items of the newest unread mail in `mailbox`, with the `links` and `invitation` and the HTML-only
 * `firstParagraph` that `desk-mail` prints for the same messages, plus INBOX mail from the look-back that holds an open
 * invitation. Everything is read with BODY.PEEK in read-only folders. A failed links, invitations or look-back read
 * lists the mail without that field and warns once.
 */
export async function readItems(box: ReadBox, input: ItemsInput): Promise<DeskSourceMail[]> {
  const warn = input.warn ?? (() => undefined);
  const now = input.now ?? Date.now();
  const orEmpty = <V>(what: string) => (err: unknown): Map<number, V> => {
    warn(`${what} were not read: ${errorText(err)}`);
    return new Map();
  };
  const listed = await box.inFolder(input.mailbox, async () => {
    const uids = await box.search({ unseen: true }, input.limit);
    if (uids.length === 0) return null;
    const messages = await box.fetch(uids, { envelope: true, bodyStructure: true, internalDate: true, headers: HEADER_FIELDS });
    const paragraphs = new Map<number, string | undefined>();
    const htmlByUid = new Map<number, string>();
    for (const m of messages) paragraphs.set(m.uid, await paragraphOf(box, m, htmlByUid).catch(() => undefined));
    const links = await linksIn(box, uids, { warn, htmlByUid }).catch(orEmpty<DeskMailLink[]>("links"));
    const invitations = await invitationsIn(box, uids, input.self, { warn }).catch(orEmpty<DeskMailInvitation>("invitations"));
    return { messages, paragraphs, links, invitations };
  });
  const messages = listed?.messages ?? [];
  const lookback = await lookbackIn(box, {
    since: new Date(now - input.invite.days * DAY_MS),
    scan: input.invite.scan,
    skip: input.mailbox.toUpperCase() === "INBOX" ? new Set(messages.map((m) => m.uid)) : new Set<number>(),
    self: input.self,
    warn,
  }).catch((err: unknown) => {
    warn(`older invitations and invitation replies were not read: ${errorText(err)}`);
    return { replies: new Map<string, number>(), candidates: [] as LookbackCandidate[] };
  });
  const items: DeskSourceMail[] = [];
  for (const m of messages) {
    const received = m.internalDate ? new Date(m.internalDate) : new Date(now);
    const item = m.envelope ? toDeskMail(m.envelope, input.account, listed?.paragraphs.get(m.uid), received) : null;
    if (!item) continue;
    const headers = headersOf(m, input.authserv);
    const links = listed?.links.get(m.uid);
    const found = listed?.invitations.get(m.uid);
    const invitation = found && invitationOpen(found, lookback.replies, now) ? found : undefined;
    items.push({ ...item, ...(headers ? { headers } : {}), ...(links ? { links } : {}), ...(invitation ? { invitation } : {}) });
  }
  const older = lookbackItems(lookback.candidates, { account: input.account, listed: new Set(items.map((i) => i.id)), replies: lookback.replies, now, limit: input.invite.limit });
  const olderHeaders = older.length === 0
    ? new Map<number, DeskMailHeaders>()
    : await box.inFolder("INBOX", async () => {
        const out = new Map<number, DeskMailHeaders>();
        for (const m of await box.fetch(older.map((o) => o.uid), { headers: HEADER_FIELDS })) {
          const h = headersOf(m, input.authserv);
          if (h) out.set(m.uid, h);
        }
        return out;
      }).catch(orEmpty<DeskMailHeaders>("headers"));
  for (const o of older) {
    const h = olderHeaders.get(o.uid);
    items.push({ ...o.mail, ...(h ? { headers: h } : {}) });
  }
  return items;
}
