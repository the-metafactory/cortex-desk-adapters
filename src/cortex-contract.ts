import type { z } from "zod";
import type {
  AskCard,
  AskFields,
  AskKind,
  MailHeaders,
  MailInvitation,
  MailLink,
  MailDraftCommandRequestSchema,
  MailInvitationReplyCommandRequestSchema,
  MailLocateCommandRequestSchema,
  MailMoveCommandRequestSchema,
  MailReportCommandRequestSchema,
  MailRestoreCommandRequestSchema,
  SourceEvent,
  SourceMail,
  SourceSent,
  WriterRequest,
} from "@the-metafactory/cortex/desk-sdk";

export {
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
} from "@the-metafactory/cortex/desk-sdk";
export type { AskCard, AskFields, AskKind, ParserRequest, WriterRequest } from "@the-metafactory/cortex/desk-sdk";

export type DeskSourceEvent = SourceEvent;
export type DeskSourceMail = SourceMail;
export type DeskSourceSentMail = SourceSent;
export type DeskMailHeaders = MailHeaders;
export type DeskMailInvitation = MailInvitation;
export type DeskMailLink = MailLink;
export type DeskPartStat = NonNullable<MailInvitation["attendee"]>["status"];
export type DeskAuthVerdict = NonNullable<NonNullable<MailHeaders["authResults"]>["spf"]>;
export type DeskMailAddress = SourceSent["from"];
export type DeskSentReply = NonNullable<SourceSent["replies"]>[number];

export type DeskWriteRequest = AskCard;
export type DeskWriteInput = WriterRequest;
export type DeskWriteKind = Exclude<AskKind, "conversation">;
export type DeskCalendarFields = AskFields["calendar"];
export type DeskTaskFields = AskFields["task"];
export type DeskGoalFields = AskFields["goal"];

export type DeskMoveTarget = z.infer<typeof MailMoveCommandRequestSchema>["target"];
export type DeskMailMoveRequest = z.infer<typeof MailMoveCommandRequestSchema>;
export type DeskMailRestoreRequest = z.infer<typeof MailRestoreCommandRequestSchema>;
export type DeskMailLocateRequest = z.infer<typeof MailLocateCommandRequestSchema>;
export type DeskMailDraftRequest = z.infer<typeof MailDraftCommandRequestSchema>;
export type DeskMailReportRequest = z.infer<typeof MailReportCommandRequestSchema> & { to: string };
export type DeskInviteReplyRequest = z.infer<typeof MailInvitationReplyCommandRequestSchema>;
