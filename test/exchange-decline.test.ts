import { expect, it } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodeKeychainPassword, type Ews, ewsTransport, icalAccount, readDeclinedCopyRequest, removeDeclinedCopy } from "../src/exchange-decline";
import type { Runner } from "../src/run";
import { Refusal } from "../src/writers";

interface Item {
  id: string;
  uid: string;
  organizer?: boolean;
  type?: string;
  subject?: string;
}

const item = (i: Item): string =>
  `<t:CalendarItem><t:ItemId Id="${i.id}" ChangeKey="ck"/><t:Subject>${i.subject ?? "Probe"}</t:Subject><t:UID>${i.uid}</t:UID><t:IsOrganizer>${i.organizer ? "true" : "false"}</t:IsOrganizer><t:CalendarItemType>${i.type ?? "Single"}</t:CalendarItemType></t:CalendarItem>`;

const ok = (op: string, inner = ""): string =>
  `<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><m:${op}Response><m:ResponseMessages><m:${op}ResponseMessage ResponseClass="Success"><m:ResponseCode>NoError</m:ResponseCode>${inner}</m:${op}ResponseMessage></m:ResponseMessages></m:${op}Response></s:Body></s:Envelope>`;

const found = (items: Item[]): string => ok("FindItem", `<m:RootFolder><t:Items>${items.map(item).join("")}</t:Items></m:RootFolder>`);

function exchange(calendar: Item[], masters: Record<string, Item> = {}, deleteAnswer?: string) {
  const calls: string[] = [];
  const deleted: string[] = [];
  const ews: Ews = async (body) => {
    calls.push(body);
    if (body.includes("<m:FindItem")) return found(calendar.filter((c) => !deleted.includes(c.id)));
    if (body.includes("<m:GetItem")) {
      const occ = /OccurrenceId="([^"]+)"/.exec(body)?.[1] ?? "";
      const master = masters[occ];
      return ok("GetItem", master ? `<m:Items>${item(master)}</m:Items>` : "");
    }
    if (body.includes("<m:DeleteItem")) {
      if (deleteAnswer) return deleteAnswer;
      for (const m of body.matchAll(/ItemId Id="([^"]+)"/g)) if (m[1]) deleted.push(m[1]);
      return ok("DeleteItem");
    }
    throw new Error("unexpected EWS call");
  };
  return { ews, calls, deleted };
}

const req = { action: "remove-declined", account: "work", uid: "probe-uid-1@example.org", start: "2026-11-05T06:00:00.000Z", end: "2026-11-05T06:30:00.000Z" } as const;

it("removes only the item whose UID is the invitation's, to Deleted Items, without telling the organizer", async () => {
  const fake = exchange([
    { id: "A", uid: req.uid },
    { id: "B", uid: "other-uid@example.org", subject: "Probe" },
  ]);
  const result = await removeDeclinedCopy(req, fake.ews);
  expect(result).toEqual({ id: req.uid, message: "Exchange's tentative copy is removed from your calendar." });
  expect(fake.deleted).toEqual(["A"]);
  const del = fake.calls.find((c) => c.includes("<m:DeleteItem")) ?? "";
  expect(del).toContain('DeleteType="MoveToDeletedItems"');
  expect(del).toContain('SendMeetingCancellations="SendToNone"');
  const find = fake.calls[0] ?? "";
  expect(find).toContain('StartDate="2026-11-04T06:00:00.000Z"');
  expect(find).toContain('EndDate="2026-11-06T06:30:00.000Z"');
});

it("is safe to run twice: the second run finds no copy and deletes nothing", async () => {
  const fake = exchange([{ id: "A", uid: req.uid }]);
  await removeDeclinedCopy(req, fake.ews);
  const again = await removeDeclinedCopy(req, fake.ews);
  expect(again.message).toBe("Your Exchange calendar holds no copy of this invitation.");
  expect(fake.calls.filter((c) => c.includes("<m:DeleteItem"))).toHaveLength(1);
});

it("never removes an item with the same title and time but another UID", async () => {
  const fake = exchange([{ id: "B", uid: `${req.uid}-not` }, { id: "C", uid: req.uid.toUpperCase() }]);
  const result = await removeDeclinedCopy(req, fake.ews);
  expect(result.message).toBe("Your Exchange calendar holds no copy of this invitation.");
  expect(fake.calls.some((c) => c.includes("<m:DeleteItem"))).toBe(false);
});

it("refuses an event the principal organizes", async () => {
  const fake = exchange([{ id: "A", uid: req.uid, organizer: true }]);
  await expect(removeDeclinedCopy(req, fake.ews)).rejects.toThrow(new Refusal("You organize this event, so the Desk does not remove it."));
  expect(fake.calls.some((c) => c.includes("<m:DeleteItem"))).toBe(false);
});

it("removes a recurring invitation through its series master, once, after checking the master's UID", async () => {
  const fake = exchange(
    [
      { id: "occ1", uid: req.uid, type: "Occurrence" },
      { id: "occ2", uid: req.uid, type: "Occurrence" },
    ],
    { occ1: { id: "M", uid: req.uid, type: "RecurringMaster" }, occ2: { id: "M", uid: req.uid, type: "RecurringMaster" } },
  );
  await removeDeclinedCopy({ ...req, recurring: true }, fake.ews);
  expect(fake.deleted).toEqual(["M"]);
  expect(fake.calls.filter((c) => c.includes("<m:GetItem"))).toHaveLength(1);
});

it("refuses an invitation for one meeting of a series, so the series stays", async () => {
  const fake = exchange([{ id: "occ1", uid: req.uid, type: "Exception" }], { occ1: { id: "M", uid: req.uid, type: "RecurringMaster" } });
  await expect(removeDeclinedCopy(req, fake.ews)).rejects.toThrow("This invitation is for one meeting of a series, so the Desk does not remove it from Exchange.");
  expect(fake.calls.some((c) => c.includes("<m:GetItem") || c.includes("<m:DeleteItem"))).toBe(false);
});

it("refuses a series master with another UID", async () => {
  const fake = exchange([{ id: "occ1", uid: req.uid, type: "Occurrence" }], { occ1: { id: "M", uid: "someone-else" } });
  await expect(removeDeclinedCopy({ ...req, recurring: true }, fake.ews)).rejects.toThrow("The series Exchange returned is not this invitation.");
  expect(fake.deleted).toEqual([]);
});

it("surfaces an Exchange error from the delete", async () => {
  const refused = `<s:Envelope><s:Body><m:DeleteItemResponse><m:ResponseMessages><m:DeleteItemResponseMessage ResponseClass="Error"><m:MessageText>Access is denied.</m:MessageText><m:ResponseCode>ErrorAccessDenied</m:ResponseCode></m:DeleteItemResponseMessage></m:ResponseMessages></m:DeleteItemResponse></s:Body></s:Envelope>`;
  const fake = exchange([{ id: "A", uid: req.uid }], {}, refused);
  await expect(removeDeclinedCopy(req, fake.ews)).rejects.toThrow("Access is denied.");
});

it("treats an item already gone at delete time as removed", async () => {
  const gone = `<s:Envelope><s:Body><m:DeleteItemResponse><m:ResponseMessages><m:DeleteItemResponseMessage ResponseClass="Error"><m:MessageText>Not found.</m:MessageText><m:ResponseCode>ErrorItemNotFound</m:ResponseCode></m:DeleteItemResponseMessage></m:ResponseMessages></m:DeleteItemResponse></s:Body></s:Envelope>`;
  const fake = exchange([{ id: "A", uid: req.uid }], {}, gone);
  expect((await removeDeclinedCopy(req, fake.ews)).message).toBe("Exchange's tentative copy is removed from your calendar.");
});

it("surfaces a SOAP fault", async () => {
  const ews: Ews = async () => "<s:Envelope><s:Body><s:Fault><faultstring>The request failed schema validation.</faultstring></s:Fault></s:Body></s:Envelope>";
  await expect(removeDeclinedCopy(req, ews)).rejects.toThrow("The request failed schema validation.");
});

it("reads XML-escaped UIDs and item ids", async () => {
  const uid = "a&b<c>@example.org";
  const fake = exchange([{ id: "X&amp;1", uid: "a&amp;b&lt;c&gt;@example.org" }]);
  await removeDeclinedCopy({ ...req, uid }, fake.ews);
  expect(fake.calls.find((c) => c.includes("<m:DeleteItem"))).toContain('Id="X&amp;1"');
});

it("parses the request and refuses a malformed one", () => {
  expect(readDeclinedCopyRequest(JSON.stringify({ ...req, recurring: true }))).toEqual({ ...req, recurring: true });
  expect(() => readDeclinedCopyRequest(JSON.stringify({ ...req, action: "invite-reply" }))).toThrow("This command only removes declined invitations.");
  expect(() => readDeclinedCopyRequest(JSON.stringify({ ...req, uid: "a\nb" }))).toThrow("The request has no valid invitation UID.");
  expect(() => readDeclinedCopyRequest(JSON.stringify({ ...req, start: "soon" }))).toThrow("The request has no valid start time.");
  expect(() => readDeclinedCopyRequest("{")).toThrow("The request is not valid JSON.");
});

it("reads the ical account and its keychain password without putting the password in argv", async () => {
  const dir = await mkdtemp(join(tmpdir(), "desk-ical-"));
  const path = join(dir, "config.json");
  await writeFile(path, JSON.stringify({ accounts: [{ name: "me", url: "https://mail.example.org/EWS/Exchange.asmx", username: "me@example.org", domain: "corp" }] }));
  const calls: string[][] = [];
  const run: Runner = async (argv) => {
    calls.push(argv);
    return { code: 0, stdout: "s3cret\n", stderr: "" };
  };
  expect(await icalAccount("me", run, path)).toEqual({ url: "https://mail.example.org/EWS/Exchange.asmx", user: "corp\\me@example.org", pass: "s3cret" });
  expect(calls).toEqual([["security", "find-generic-password", "-a", "ical-calendar", "-s", "ical-exchange-me", "-w"]]);
  await expect(icalAccount("other", run, path)).rejects.toThrow("There is no Exchange account other in the ical config.");
  const failing: Runner = async () => ({ code: 44, stdout: "", stderr: "The specified item could not be found in the keychain." });
  await expect(icalAccount("me", failing, path)).rejects.toThrow("The Exchange password could not be read from the keychain");
});

it("fails on an answer that is not SOAP, such as a proxy login page, instead of reporting no copy", async () => {
  const ews = ewsTransport({ url: "https://mail.example.org/EWS/Exchange.asmx", user: "u", pass: "p" }, 5_000, async () => new Response("<html>Sign in</html>", { status: 200 }));
  await expect(removeDeclinedCopy(req, ews)).rejects.toThrow("Exchange answered HTTP 200 without a SOAP envelope.");
});

it("decodes a hex keychain password only when it holds non-ASCII text", () => {
  expect(decodeKeychainPassword("c3a4626364")).toBe("äbcd");
  expect(decodeKeychainPassword("deadbeef")).toBe("deadbeef");
  expect(decodeKeychainPassword("plain")).toBe("plain");
});
