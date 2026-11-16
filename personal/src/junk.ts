import type { DeskSourceMail } from "../../src/contract";
import { toDeskMail, type EmailListEntry } from "../../src/mail";
import { pickFolder, type Folder } from "../../src/move";

export const JUNK_DAYS = 7;
export const JUNK_LIMIT = 20;

/**
 * The account's recent junk mail as Desk mail, read-only: `email list` on the same Junk folder `desk-mail-move` uses for
 * its `junk` target, never `get` and never `--mark-read`, so no flag changes. A message carries no body or first paragraph.
 * Throws when the folder cannot be found or listed.
 */
export async function readJunk(
  run: (args: string[]) => Promise<string>,
  folders: () => Promise<Folder[]>,
  account: string,
  { days = JUNK_DAYS, limit = JUNK_LIMIT }: { days?: number; limit?: number } = {},
): Promise<DeskSourceMail[]> {
  const folder = pickFolder(await folders(), "junk");
  if (!folder) throw new Error("no junk folder was found");
  const listed = JSON.parse(await run(["list", "-a", account, "-m", folder, "-s", String(days), "-l", String(limit), "-o", "json"])) as EmailListEntry[];
  const cutoff = Date.now() - days * 86_400_000;
  return listed
    .filter((m) => Date.parse(m.date) >= cutoff)
    .sort((a, b) => Date.parse(b.date) - Date.parse(a.date))
    .slice(0, limit)
    .map((m) => toDeskMail(m, account, undefined));
}
