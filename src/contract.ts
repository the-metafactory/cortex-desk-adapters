import type { AskKind, DeskMoveTarget, DeskSourceEvent, DeskSourceMail, DeskSourceSentMail, DeskWriteRequest, ParserRequest } from "./cortex-contract";

/** The command contract types the adapters declare themselves. The SDK's own types and schemas come from `./cortex-contract`. */

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
  items?: (DeskSourceMail | DeskSourceSentMail)[];
  /** The newest 20 junk messages of the last 7 days, without bodies; omitted when no account's junk folder could be read. */
  junk?: DeskSourceMail[];
  /** One sentence per account part that could not be read. */
  problems?: string[];
}

/**
 * The Desk writer contract (cortex#2774): a writer prints one DeskWriteResult on success (exit 0); on refusal it exits non-zero
 * and the last line of stderr, one plain sentence, is shown to the person. A writer creates nothing it refuses.
 */
export interface DeskWriteResult {
  id: string;
  /** http(s) only. */
  url?: string;
  /** One plain sentence for the person. */
  message?: string;
}

/**
 * The task close contract (cortex#3110): Cortex writes one DeskTaskCloseRequest to the closer's stdin after the
 * person approves or discards a hand-off. The answer is a DeskWriteResult, a refusal the last line of stderr.
 */
export interface DeskTaskCloseRequest {
  action: "close";
  /** The task a writer filed, e.g. jcfischer/desk#7. */
  task: string;
  outcome: "approved" | "discarded";
  /** The Desk's receipt for the decision, e.g. ivy:<hand-off id>; the only detail the close leaves on the task. */
  receipt: string;
}

/** The Desk parser contract: Cortex writes one DeskParseRequest to the parser's stdin. */
export type DeskParseKind = Extract<AskKind, "reminder" | "note" | "task" | "goal" | "calendar" | "conversation">;

export type DeskCreationParseRequest = Omit<ParserRequest, "kinds" | "routing"> & { operation?: "create"; kinds: DeskParseKind[] };

/** The parser prints one of these; Cortex validates it and falls back to its own rules on any failure. */
export interface BalanceParentRequest {
  operation: "balance-parent";
  version: 1;
  revision: number;
  source: { key: string; fingerprint: string; text: string };
  parents: { id: string; area: string; path: string }[];
}

/** The prompts Cortex writes for the parser: the system message and the user message, sent to the provider unchanged. */
export type ParseMessages = { system: string; user: string };

export type DeskParseRequest = DeskCreationParseRequest | BalanceParentRequest;
/** What `desk-parse` reads from stdin: the request plus Cortex's prompts, as `messages: [{ role, content }]` on the wire. */
export type ParseInput = DeskParseRequest & { messages: ParseMessages };
export type BalanceParentResult = { kind: "balance-parent"; parent: string | null; reason: string };
export type DeskParseResult =
  | BalanceParentResult
  | DeskWriteRequest
  | { kind: "none"; reason: string };

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

/**
 * The declined-copy contract (cortex#3112): after a decline went out, Cortex writes this to the command configured for the
 * account under `mc.desk.mail.invitations.removeOnDecline`. The command removes the copy of the invitation that the
 * calendar server placed by itself, matched by `uid` only; `start` and `end` (ISO 8601) bound the search. The answer is a
 * DeskWriteResult, a refusal the last line of stderr.
 */
export interface DeskDeclinedCopyRequest {
  action: "remove-declined";
  account: string;
  uid: string;
  start: string;
  end?: string;
  /** The invitation carries RRULE or RDATE: the command removes the series. Without it a matching occurrence is refused. */
  recurring?: boolean;
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
