import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { isRecord } from "./guards";

/** How long a writer remembers a request id it completed, so a retry of one confirmed card does nothing twice. */
export const DEDUPE_DAYS = 30;
const DAY_MS = 86_400_000;

export async function readJson(path: string): Promise<unknown> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    return undefined;
  }
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

export interface LedgerEntry {
  id: string;
  at: number;
}
export type Ledger = Record<string, LedgerEntry>;

export async function readLedger(path: string, now: number): Promise<Ledger> {
  const body = await readJson(path);
  const ledger: Ledger = {};
  if (!isRecord(body)) return ledger;
  for (const [requestId, entry] of Object.entries(body)) {
    if (!isRecord(entry) || typeof entry.id !== "string" || typeof entry.at !== "number") continue;
    if (now - entry.at < DEDUPE_DAYS * DAY_MS) ledger[requestId] = { id: entry.id, at: entry.at };
  }
  return ledger;
}

export async function writeLedger(path: string, ledger: Ledger): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(ledger, null, 2)}\n`, { mode: 0o600 });
  await rename(tmp, path);
}

