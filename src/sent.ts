import type { DeskMailAddress, DeskSentReply, DeskSourceSentMail } from "./contract";
import { appleMailUrl } from "./mail";

export const SENT_NAMES = ["Sent", "Sent Items", "Sent Messages", "Sent Mail", "Gesendete Elemente", "Gesendete Objekte", "Gesendet", "Éléments envoyés"] as const;
export const ARCHIVE_NAMES = ["Archive", "Archives", "Archiv"] as const;

export interface SentFolder {
  path: string;
  name: string;
  specialUse?: string;
}

/**
 * The folders sent mail may be in: the one flagged \\Sent and every folder with a usual Sent name, at most three.
 * Exchange can flag a stale folder (for example "Deleted Items/Sent") while the mail is in "Sent Items".
 */
export function sentFolders(boxes: readonly SentFolder[]): string[] {
  const names = new Set<string>(SENT_NAMES.map((n) => n.toLowerCase()));
  const flagged = boxes.filter((b) => b.specialUse === "\\Sent").map((b) => b.path);
  const named = boxes.filter((b) => names.has(b.path.toLowerCase())).map((b) => b.path);
  return [...new Set([...flagged, ...named])].slice(0, 3);
}

export const SENT_LIMITS = { recipients: 20, replies: 10, text: 1000, subject: 500 } as const;

const QUOTE_START: readonly RegExp[] = [
  /^>/,
  /^on .{1,200} wrote:$/i,
  /^am .{1,200} schrieb .{0,200}:$/i,
  /^le .{1,200} a écrit\s?:$/i,
  /^-{2,}\s*(original message|ursprüngliche nachricht|message d'origine|forwarded message|weitergeleitete nachricht)/i,
  /^(from|von|de):\s.+/i,
  /^-- ?$/,
  /^_{5,}$/,
];

/** The start of a sent mail's plain-text body: lines before the first quote, attribution, forwarded header or signature, on one line. */
export function sentText(body: string, max: number = SENT_LIMITS.text): string | undefined {
  const kept: string[] = [];
  for (const raw of body.replace(/\r\n/g, "\n").split("\n")) {
    const line = raw.trim();
    if (QUOTE_START.some((re) => re.test(line))) break;
    if (line) kept.push(line);
  }
  const text = kept.join(" ").replace(/\s+/g, " ").trim();
  if (!text) return undefined;
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

export interface EnvelopeAddress {
  name?: string;
  address?: string;
}

export interface SentEnvelope {
  messageId?: string;
  inReplyTo?: string;
  subject?: string;
  date?: Date;
  from?: EnvelopeAddress[];
  to?: EnvelopeAddress[];
  cc?: EnvelopeAddress[];
}

const bare = (id: string): string => id.trim().replace(/^<|>$/g, "");

const ADDRESS = /^[^\s<>@,;]+@[^\s<>@,;]+$/;

function address(a: EnvelopeAddress | undefined): DeskMailAddress | null {
  const value = a?.address?.trim().toLowerCase();
  if (!value || !ADDRESS.test(value)) return null;
  const name = a?.name?.replace(/\s+/g, " ").trim();
  return name ? { name, address: value } : { address: value };
}

function recipients(env: SentEnvelope): DeskMailAddress[] {
  const seen = new Set<string>();
  const out: DeskMailAddress[] = [];
  for (const a of [...(env.to ?? []), ...(env.cc ?? [])]) {
    const r = address(a);
    if (!r || seen.has(r.address)) continue;
    seen.add(r.address);
    out.push(r);
  }
  return out.slice(0, SENT_LIMITS.recipients);
}

/** One sent message as a Desk `sent` item, or null without a Message-ID, a sender or a recipient. */
export function toSentMail(env: SentEnvelope, account: string, more: { text?: string; references?: string[] } = {}): DeskSourceSentMail | null {
  const id = env.messageId ? bare(env.messageId) : "";
  const from = address(env.from?.[0]);
  const to = recipients(env);
  if (!id || !from || to.length === 0 || !env.date) return null;
  const inReplyTo = env.inReplyTo ? bare(env.inReplyTo) : "";
  const subject = (env.subject ?? "").replace(/\s+/g, " ").trim().slice(0, SENT_LIMITS.subject) || "(no subject)";
  return {
    kind: "sent",
    id,
    from,
    to,
    subject,
    sentAt: env.date.toISOString(),
    ...(more.text ? { text: more.text } : {}),
    url: appleMailUrl(id),
    account,
    ...(inReplyTo ? { inReplyTo } : {}),
    ...(more.references?.length ? { references: more.references } : {}),
  };
}

/** A message that may answer a sent mail: its sender, date and the Message-IDs it replies to. */
export interface ReplyCandidate {
  id: string;
  from: DeskMailAddress;
  at: string;
  parents: readonly string[];
}

export function replyCandidate(env: SentEnvelope, references: readonly string[]): ReplyCandidate | null {
  const id = env.messageId ? bare(env.messageId) : "";
  const from = address(env.from?.[0]);
  if (!id || !from || !env.date) return null;
  const parents = [...new Set([...(env.inReplyTo ? [bare(env.inReplyTo)] : []), ...references])];
  return parents.length > 0 ? { id, from, at: env.date.toISOString(), parents } : null;
}

/** The replies to one sent mail: candidates that name it in In-Reply-To or References and come from someone else, oldest first. */
export function repliesTo(sent: Pick<DeskSourceSentMail, "id" | "from">, candidates: readonly ReplyCandidate[]): DeskSentReply[] {
  return candidates
    .filter((c) => c.id !== sent.id && c.from.address !== sent.from.address && c.parents.includes(sent.id))
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
    .slice(0, SENT_LIMITS.replies)
    .map(({ id, from, at }) => ({ id, from, at }));
}

export function withReplies(sent: DeskSourceSentMail, candidates: readonly ReplyCandidate[]): DeskSourceSentMail {
  const replies = repliesTo(sent, candidates);
  return replies.length > 0 ? { ...sent, replies } : sent;
}
