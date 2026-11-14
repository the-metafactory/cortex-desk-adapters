import type { DeskSourceEvent } from "./contract";

/** The most attendees Cortex keeps per event (cortex#3628). */
export const MAX_EVENT_ATTENDEES = 500;

const ADDRESS = /^[^\s<>@,;]+@[^\s<>@,;]+$/;

/** A lowercase mail address in the form Cortex accepts, or null for a name, an Exchange legacy DN or anything else. */
export function mailAddress(value: string | null | undefined): string | null {
  const address = (value ?? "").trim().toLowerCase();
  return address.length >= 3 && address.length <= 320 && ADDRESS.test(address) ? address : null;
}

/**
 * The `organizer` and `attendees` fields of a Desk event, addresses only. A field is left out when the source gives no readable
 * address for it, because Cortex reads an empty or unreadable list as "nobody may link mail to this meeting". This fails open:
 * a meeting whose people are all names or Exchange legacy DNs carries neither field, so Cortex checks no sender for it, as before.
 */
export function eventPeople(organizer: string | null | undefined, attendees: readonly (string | null | undefined)[]): Pick<DeskSourceEvent, "organizer" | "attendees"> {
  const lead = mailAddress(organizer);
  const listed = [...new Set(attendees.map(mailAddress).filter((a): a is string => a !== null))].slice(0, MAX_EVENT_ATTENDEES);
  return {
    ...(lead ? { organizer: { address: lead } } : {}),
    ...(listed.length > 0 ? { attendees: listed.map((address) => ({ address })) } : {}),
  };
}
