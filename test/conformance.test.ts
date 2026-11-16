import { describe, expect, test } from "bun:test";
import { INVITATION_OPEN_VECTORS, REPLIES_TO_VECTORS } from "@the-metafactory/cortex/desk-sdk";
import type { DeskMailInvitation } from "../src/cortex-contract";
import { invitationOpen } from "../src/invitation-lookback";
import { repliesTo, type ReplyCandidate } from "../src/sent";

describe("invitationOpen conforms to the Desk SDK vectors", () => {
  for (const v of INVITATION_OPEN_VECTORS) {
    test(v.name, () => {
      const invitation = { uid: "uid-1", ...v.input.invitation } as unknown as DeskMailInvitation;
      const replies = new Map<string, number>();
      if (v.input.answeredSequence !== undefined) replies.set("uid-1", v.input.answeredSequence);
      expect(invitationOpen(invitation, replies, v.input.now)).toBe(v.expected);
    });
  }
});

describe("repliesTo conforms to the Desk SDK vectors", () => {
  const addr = (a: string) => ({ address: a.trim().toLowerCase() });
  for (const v of REPLIES_TO_VECTORS) {
    test(v.name, () => {
      const candidates: ReplyCandidate[] = v.input.candidates.map((c) => ({
        id: c.id,
        from: addr(c.from),
        at: c.receivedAt,
        parents: [...new Set([...(c.inReplyTo ?? []), ...(c.references ?? [])])],
      }));
      const actual = repliesTo({ id: v.input.sent.id, from: addr(v.input.sent.from) }, candidates).map((r) => r.id);
      expect(actual).toEqual([...v.expected]);
    });
  }
});
