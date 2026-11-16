import { expect, it } from "bun:test";
import { readJunk } from "../src/junk";
import type { Folder } from "../../src/move";

const FOLDERS: Folder[] = [
  { path: "INBOX", name: "INBOX", specialUse: "\\Inbox" },
  { path: "Spam Box", name: "Spam Box", specialUse: "\\Junk" },
];
const ago = (days: number): string => new Date(Date.now() - days * 86_400_000).toISOString();
const entry = (n: number, days: number, flags: string[] = []) => ({ uid: n, messageId: `<j${n}@spam.example>`, from: `Spammer <s${n}@spam.example>`, subject: `Offer ${n}`, date: ago(days), snippet: "buy now", flags });

function fixtureCli(listing: unknown[]) {
  const calls: string[][] = [];
  const run = async (args: string[]): Promise<string> => {
    calls.push(args);
    return JSON.stringify(listing);
  };
  return { run, calls };
}

it("lists the junk folder read-only and emits mail fields without a body or first paragraph", async () => {
  const { run, calls } = fixtureCli([entry(1, 1), entry(2, 2, ["\\Seen"])]);
  const junk = await readJunk(run, async () => FOLDERS, "work");
  expect(junk.map((m) => [m.id, m.unread, m.account])).toEqual([["j1@spam.example", true, "work"], ["j2@spam.example", false, "work"]]);
  expect(junk.every((m) => !("firstParagraph" in m))).toBe(true);
  expect(calls).toEqual([["list", "-a", "work", "-m", "Spam Box", "-s", "7", "-l", "20", "-o", "json"]]);
});

it("never reads a body and never marks anything read, so no flag changes", async () => {
  const { run, calls } = fixtureCli([entry(1, 1)]);
  await readJunk(run, async () => FOLDERS, "work");
  for (const args of calls) {
    expect(args[0]).toBe("list");
    expect(args).not.toContain("--mark-read");
  }
});

it("keeps the 20 newest messages of the last 7 days", async () => {
  const many = Array.from({ length: 30 }, (_, i) => entry(i + 1, i * 0.2));
  const { run } = fixtureCli([...many, entry(99, 9)]);
  const junk = await readJunk(run, async () => FOLDERS, "work");
  expect(junk).toHaveLength(20);
  expect(junk[0]?.id).toBe("j1@spam.example");
  expect(junk.some((m) => m.id === "j99@spam.example")).toBe(false);
});

it("throws when the junk folder is missing or the listing fails", async () => {
  const { run } = fixtureCli([]);
  await expect(readJunk(run, async () => [FOLDERS[0]!], "work")).rejects.toThrow("no junk folder");
  await expect(readJunk(async () => { throw new Error("email list exited 1"); }, async () => FOLDERS, "work")).rejects.toThrow("exited 1");
});
