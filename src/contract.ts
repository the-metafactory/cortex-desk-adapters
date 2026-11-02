/**
 * The Desk source contract (cortex#2772): a source is a command that prints one JSON object on stdout.
 * Cortex runs it from `mc.desk.sources`, validates this shape and drops what does not match.
 */

export interface DeskSourceEvent {
  availability?: { status: "busy" | "free" | "unknown"; provenance: string };
  calendarId?: string;
  /** Stable within the source, e.g. the calendar's event id or date+title. */
  id: string;
  /** ISO 8601 start. For an all-day event, the day at 00:00 local time. */
  start: string;
  end?: string;
  allDay?: boolean;
  title: string;
  location?: string;
  online?: boolean;
  /** A link that opens the event or joins the meeting. */
  url?: string;
  /** The calendar the event belongs to, e.g. for per-calendar colours. */
  calendar?: string;
}

export interface DeskSourceMail {
  kind: "mail";
  /** The RFC 5322 Message-ID without angle brackets. */
  id: string;
  from: { name?: string; address: string };
  subject: string;
  /** ISO 8601. */
  receivedAt: string;
  unread: boolean;
  firstParagraph?: string;
  /** Opens the message in the principal's mail client, e.g. message://%3Cid%3E for Apple Mail. */
  url?: string;
  account?: string;
  /** Headers later Desk steps read. Cortex treats every value as untrusted data. */
  headers?: DeskMailHeaders;
  /** Links in the HTML body whose text names a host (at most 20), for the Desk's phishing check. Untrusted data. */
  links?: DeskMailLink[];
}

/** One link: the text a reader sees and the http(s) address it opens. */
export interface DeskMailLink {
  text: string;
  href: string;
}

/** An SPF, DKIM or DMARC verdict from the topmost Authentication-Results header. */
export type DeskAuthVerdict = "pass" | "fail" | "softfail" | "neutral" | "none" | "temperror" | "permerror" | "policy";

export interface DeskMailHeaders {
  listId?: string;
  listUnsubscribe?: string;
  listUnsubscribePost?: string;
  /** `dkimDomains`: the signing domains of the passing DKIM signatures in the same header, possibly none; `spfDomain`: the domain SPF checked (smtp.mailfrom). */
  authResults?: { spf?: DeskAuthVerdict; dkim?: DeskAuthVerdict; dmarc?: DeskAuthVerdict; dkimDomains?: string[]; spfDomain?: string };
  replyTo?: string;
  inReplyTo?: string;
}

export interface DeskSourceOutput {
  capabilities?: ("calendar" | "attention")[];
  calendarCoverage?: {
    from: string;
    to: string;
    calendars: { id: string; name: string }[];
    status: "complete" | "partial";
    provenance: string;
  };
  events?: DeskSourceEvent[];
  items?: DeskSourceMail[];
}

/**
 * The Desk writer contract (cortex#2774): Cortex writes one DeskWriteInput (a DeskWriteRequest plus its requestId) to a writer's stdin.
 * On success the writer exits 0 and prints one DeskWriteResult; on refusal it exits non-zero and the
 * last line of stderr, one plain sentence, is shown to the person. A writer creates nothing it refuses.
 */
export type DeskWriteKind = "calendar" | "task" | "goal" | "note" | "reminder";

export interface DeskCalendarFields {
  title: string;
  /** ISO 8601. */
  start: string;
  end?: string;
  allDay?: boolean;
  location?: string;
  notes?: string;
}

export interface DeskTaskFields {
  title: string;
  details?: string;
  /** A work-graph root ref, e.g. the-metafactory/cortex#2770. */
  map: string;
}

export interface DeskGoalFields {
  wording: string;
}

export type DeskWriteRequest =
  | { kind: "calendar"; fields: DeskCalendarFields }
  | { kind: "task"; fields: DeskTaskFields }
  | { kind: "goal"; fields: DeskGoalFields }
  | { kind: "note"; fields: { text: string } }
  | { kind: "reminder"; fields: { text: string; due: string } };

/**
 * What a writer reads on stdin: a request plus the id of the confirmed Desk card, 8–64 of [A-Za-z0-9_-].
 * Every retry of one card carries the same id, so a writer can recognise a write it already made.
 */
export type DeskWriteInput = DeskWriteRequest & { requestId: string };

export interface DeskWriteResult {
  id: string;
  /** http(s) only. */
  url?: string;
  /** One plain sentence for the person. */
  message?: string;
}

/** The Desk parser contract: Cortex writes one DeskParseRequest to the parser's stdin. */
export type DeskParseKind = DeskWriteKind;

export interface DeskCreationParseRequest {
  operation?: "create";
  text: string;
  /** ISO 8601. */
  now: string;
  /** IANA, e.g. Europe/Zurich. */
  timeZone: string;
  kinds: DeskParseKind[];
  maps: { ref: string; label: string }[];
}

/** The parser prints one of these; Cortex validates it and falls back to its own rules on any failure. */
export interface BalanceParentRequest {
  operation: "balance-parent";
  version: 1;
  revision: number;
  source: { key: string; fingerprint: string; text: string };
  parents: { id: string; area: string; path: string }[];
}

export type DeskParseRequest = DeskCreationParseRequest | BalanceParentRequest;
export type BalanceParentResult = { kind: "balance-parent"; parent: string | null; reason: string };
export type DeskParseResult =
  | BalanceParentResult
  | DeskWriteRequest
  | { kind: "none"; reason: string };

/** The legacy Desk mail-action contract: Cortex writes this to the `mc.desk.mail.actions.trash` command's stdin when no move command is set. */
export interface DeskMailActionRequest {
  action: "trash";
  /** The account name the mail source put on the item. */
  account: string;
  /** The Message-ID without angle brackets, as the mail source sent it. */
  messageId: string;
}

/** Where a move sends a mail. The command resolves each target to one folder per account; nothing is ever expunged. */
export type DeskMoveTarget = "archive" | "junk" | "trash";

/** The Desk move contract: Cortex writes this to the `mc.desk.mail.actions.move` command's stdin for Archive, Spam and Delete. */
export interface DeskMailMoveRequest {
  action: "move";
  account: string;
  /** The Message-ID without angle brackets. The command moves the one INBOX message with it, or refuses. */
  messageId: string;
  target: DeskMoveTarget;
}

/** Undo of a move: the same command moves the one message with this Message-ID from the target's folder back to INBOX. */
export interface DeskMailRestoreRequest {
  action: "restore";
  account: string;
  messageId: string;
  /** The target the mail was moved to. */
  from: DeskMoveTarget;
}

/** Where a mail is now: the same command answers it for a mail that left the Desk's list without a Desk action. */
export interface DeskMailLocateRequest {
  action: "locate";
  account: string;
  messageId: string;
}

/** `place` is the folder kind the message is in; `gone` when it is in none of INBOX, Archive, Junk or Trash. */
export interface DeskMailLocateResult extends DeskWriteResult {
  place: "inbox" | DeskMoveTarget | "gone";
  folder?: string;
  unread?: boolean;
}

/** What the move command prints on success: a receipt that names the folder. */
export interface DeskMailMoveResult extends DeskWriteResult {
  /** The folder the message is in now, e.g. "Archive", "Junk" or "INBOX". */
  folder: string;
  message: string;
}

/** The Desk reply-draft contract: Cortex writes this to the `mc.desk.mail.actions.draft` command's stdin. The command never sends. */
export interface DeskMailDraftRequest {
  action: "draft";
  account: string;
  /** The Message-ID being replied to, without angle brackets. */
  messageId: string;
  /** The original sender's address. */
  to: string;
  subject: string;
  body: string;
}

/**
 * The Desk report contract: Cortex writes this to the `mc.desk.mail.report.command` command's stdin for Report. The
 * command saves a draft to `to` with the original attached as message/rfc822, for the principal to send. It never sends.
 */
export interface DeskMailReportRequest {
  action: "report";
  account: string;
  /** The Message-ID without angle brackets; the message is looked up in INBOX, then in Junk. */
  messageId: string;
  to: string;
}

/** The Desk DMARC contract: Cortex writes this to the `mc.desk.mail.dmarc.command` command's stdin for a report mail a rule kept for the digest. */
export interface DeskDmarcRequest {
  action: "dmarc";
  account: string;
  /** The Message-ID without angle brackets. The command reads the one INBOX message with it, read-only. */
  messageId: string;
}

/** A source IP whose mail failed SPF or DKIM (as DMARC evaluated them), with counts. */
export interface DeskDmarcSource {
  ip: string;
  /** Messages from this source that failed SPF or DKIM. */
  count: number;
  spfFail: number;
  dkimFail: number;
  /** Messages that failed both, so failed DMARC. */
  dmarcFail: number;
}

/** Counts for one header-from domain of a report. SPF and DKIM are the policy-evaluated (aligned) verdicts. */
export interface DeskDmarcDomain {
  domain: string;
  messages: number;
  spf: { pass: number; fail: number };
  dkim: { pass: number; fail: number };
  dmarcFail: number;
  disposition: { none: number; quarantine: number; reject: number };
  /** At most five sources, most failing messages first. */
  failing: DeskDmarcSource[];
}

/** What the DMARC command prints on success. A refused report exits 3 with one sentence on stderr; any other failure exits 1. */
export interface DeskDmarcReport {
  /** The Message-ID of the report mail, without angle brackets. */
  id: string;
  org: string;
  reportId: string;
  /** ISO 8601 */
  begin: string;
  end: string;
  policyDomain: string;
  domains: DeskDmarcDomain[];
  /** One plain sentence for the person. */
  message: string;
}
