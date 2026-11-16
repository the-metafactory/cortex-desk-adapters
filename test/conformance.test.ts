import { describe, expect, test } from "bun:test";
import { INVITATION_OPEN_VECTORS, REPLIES_TO_VECTORS } from "@the-metafactory/cortex/desk-sdk";
import type { DeskMailInvitation } from "../src/cortex-contract";
import { invitationOpen } from "../src/invitation-lookback";
import { address, repliesTo, replyCandidate } from "../src/sent";

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
  for (const v of REPLIES_TO_VECTORS) {
    test(v.name, () => {
      const sentFrom = address({ address: v.input.sent.from });
      if (!sentFrom) throw new Error(`vector ${v.name}: sent.from is not an address`);
      const candidates = v.input.candidates.flatMap((c) => {
        const [first, ...rest] = c.inReplyTo ?? [];
        const candidate = replyCandidate(
          { messageId: c.id, inReplyTo: first, from: [{ address: c.from }], date: new Date(c.receivedAt) },
          [...rest, ...(c.references ?? [])],
        );
        return candidate ? [candidate] : [];
      });
      const actual = repliesTo({ id: v.input.sent.id, from: sentFrom }, candidates).map((r) => r.id);
      expect(actual).toEqual([...v.expected]);
    });
  }
});
