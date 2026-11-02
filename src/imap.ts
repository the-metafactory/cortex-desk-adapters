import { ImapFlow } from "imapflow";
import type { ImapAccount } from "./imap-account";
import { imapAccount } from "./imap-account";
import type { DeskMailHeaders, DeskMailLink, DeskSourceSentMail } from "./contract";
import { linksOf } from "./links";
import { MAX_ORIGINAL, TOO_LARGE, type PhishingReportBox } from "./report";
import { HEADER_FIELDS, headersOf, messageIds } from "./mail-headers";
import { ReportRefusal, type Attachment, type ReportMailbox } from "./dmarc";
import { bareMessageId, folderByUse, type Mailbox } from "./move";
import { textPart, type StructureNode } from "./imap-mail";
import { ARCHIVE_NAMES, replyCandidate, sentFolders, sentText, toSentMail, withReplies, type ReplyCandidate } from "./sent";
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

async function withImapClient<T>(account: string, work: (client: ImapFlow) => Promise<T>): Promise<T> {
  const client = connectImap(await imapAccount(account, spawnRunner));
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

/** Connects to one account from the `email` CLI's config, runs `work` on its mailbox, and always logs out. */
export const withMailbox = <T>(account: string, work: (box: Mailbox) => Promise<T>): Promise<T> => withImapClient(account, (client) => work(imapMailbox(client)));

/** Reads the Desk's header fields for these INBOX UIDs, read-only (BODY.PEEK), so no message is marked read. */
export async function readHeaders(account: string, uids: number[], trustedAuthserv: readonly string[] = [], mailbox = "INBOX"): Promise<Map<number, DeskMailHeaders>> {
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
  });
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
export async function withReportMailbox<T>(account: string, work: (box: ReportMailbox) => Promise<T>, mailbox = "INBOX"): Promise<T> {
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
  });
}

const htmlPart = (structure: Part | undefined): string | undefined => {
  const html = leaves(structure).find((p) => (p.type ?? "").toLowerCase() === "text/html" && !p.dispositionParameters?.filename);
  return html ? html.part ?? "1" : undefined;
};

/** The links of each message's HTML body, for these INBOX UIDs, read-only (EXAMINE, BODY.PEEK), so no message is marked read. */
export async function readLinks(account: string, uids: number[], warn: (line: string) => void = () => undefined, mailbox = "INBOX", maxBytes = 256 * 1024): Promise<Map<number, DeskMailLink[]>> {
  const out = new Map<number, DeskMailLink[]>();
  if (uids.length === 0) return out;
  return withImapClient(account, async (client) => {
    const lock = await client.getMailboxLock(mailbox, { readOnly: true });
    try {
      for (const m of await client.fetchAll(uids, { bodyStructure: true }, { uid: true })) {
        const part = htmlPart(m.bodyStructure as Part | undefined);
        if (!part) continue;
        try {
          const { content } = await client.download(String(m.uid), part, { uid: true, maxBytes });
          const chunks: Buffer[] = [];
          for await (const chunk of content) chunks.push(chunk as Buffer);
          const links = linksOf(Buffer.concat(chunks).toString("utf8"));
          if (links.length > 0) out.set(m.uid, links);
        } catch (err) {
          warn(`the links of message ${m.uid} were not read: ${errorText(err)}`);
        }
      }
    } finally {
      lock.release();
    }
    return out;
  });
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
export function withPhishingReportBox<T>(account: string, work: (box: PhishingReportBox, user: string) => Promise<T>): Promise<T> {
  return imapAccount(account, spawnRunner).then((acct) => withImapClient(account, (client) => work(phishingReportBox(client, account), acct.user)));
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
export async function readSent(account: string, options: SentOptions): Promise<DeskSourceSentMail[]> {
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
  });
}
