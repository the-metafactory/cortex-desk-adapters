import { homedir } from "node:os";
import { join } from "node:path";
import { DEDUPE_DAYS, readJson, readLedger, writeLedger } from "./ledger";

export { DEDUPE_DAYS } from "./ledger";
import type { DeskWriteResult } from "./contract";
import { isRecord } from "./guards";
import { Refusal } from "./writers";

export const TANA_ENDPOINT = "https://europe-west1-tagr-prod.cloudfunctions.net/addToNodeV2";
export const NOTE_MAX = 1000;

export type Fetch = (url: string, init: { method: "POST"; headers: Record<string, string>; body: string }) => Promise<Response>;
type Env = Record<string, string | undefined>;

export interface TanaAccess {
  token: string;
  endpoint: string;
}

export const supertagConfigPath = (env: Env): string => join(env.XDG_CONFIG_HOME || join(homedir(), ".config"), "supertag", "config.json");

export const ledgerPath = (env: Env): string =>
  join(env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "cortex-desk-adapters", "tana-notes.json");

const nonEmpty = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);

export async function tanaAccess(env: Env, configPath = supertagConfigPath(env)): Promise<TanaAccess> {
  const config = await readJson(configPath);
  const fromFile = isRecord(config) ? config : {};
  const token = nonEmpty(env.TANA_API_TOKEN) ?? nonEmpty(fromFile.apiToken);
  if (!token) throw new Refusal("No Tana API token: set TANA_API_TOKEN or run supertag config --token.");
  const endpoint = nonEmpty(env.TANA_API_ENDPOINT) ?? nonEmpty(fromFile.apiEndpoint) ?? TANA_ENDPOINT;
  if (!/^https:\/\//.test(endpoint)) throw new Refusal("The Tana API endpoint is not an https URL.");
  return { token, endpoint };
}

export function noteText(fields: Record<string, unknown>): string {
  const v = fields.text;
  if (v === undefined) throw new Refusal("The text is missing.");
  if (typeof v !== "string") throw new Refusal("The text must be text.");
  const t = v.replace(/\s+/g, " ").trim();
  if (!t) throw new Refusal("The text is missing.");
  if (t.length > NOTE_MAX) throw new Refusal(`The text is longer than ${NOTE_MAX} characters.`);
  return t;
}

export function targetNode(target: string): string {
  if (!/^[\w-]{1,64}$/.test(target)) throw new Refusal(`"${target}" is not a Tana node id or INBOX.`);
  return target;
}

export const notePayload = (text: string, target: string) => ({ targetNodeId: target, nodes: [{ name: text }] });

export const nodeUrl = (id: string): string => `https://app.tana.inc/?nodeid=${encodeURIComponent(id)}`;

export function createdNodeId(body: unknown): string | undefined {
  if (!isRecord(body)) return undefined;
  const first = Array.isArray(body.children) ? body.children[0] : undefined;
  if (isRecord(first) && typeof first.nodeId === "string" && first.nodeId) return first.nodeId;
  const legacy = Array.isArray(body.nodeIds) ? body.nodeIds[0] : undefined;
  return typeof legacy === "string" && legacy ? legacy : undefined;
}

export interface NoteOptions {
  requestId: string;
  target: string;
  access: () => Promise<TanaAccess>;
  fetch: Fetch;
  ledgerPath: string;
  now?: () => number;
}

async function post(text: string, target: string, access: TanaAccess, fetcher: Fetch): Promise<string | undefined> {
  let response: Response;
  try {
    response = await fetcher(access.endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${access.token}` },
      body: JSON.stringify(notePayload(text, target)),
    });
  } catch (error) {
    throw new Refusal(`Tana could not be reached (${(error as Error).message}); the note may have been created, so check Tana before asking again.`);
  }
  if (response.status >= 500) throw new Refusal(`Tana failed with HTTP ${response.status}; the note may have been created, so check Tana before asking again.`);
  if (!response.ok) throw new Refusal(`Tana refused the note with HTTP ${response.status}; nothing was created.`);
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = undefined;
  }
  return createdNodeId(body);
}

const result = (id: string, nodeId: string | undefined, message: string): DeskWriteResult => ({ id, ...(nodeId ? { url: nodeUrl(nodeId) } : {}), message });

export async function writeNote(fields: Record<string, unknown>, opts: NoteOptions): Promise<DeskWriteResult> {
  const text = noteText(fields);
  const target = targetNode(opts.target);
  const now = opts.now ?? Date.now;
  const known = (await readLedger(opts.ledgerPath, now()))[opts.requestId];
  if (known) return result(known.id, known.id === opts.requestId ? undefined : known.id, "This note is already in Tana; nothing new was added.");
  const access = await opts.access();
  const nodeId = await post(text, target, access, opts.fetch);
  const id = nodeId ?? opts.requestId;
  const where = target === "INBOX" ? "your Tana Inbox" : "Tana";
  try {
    const ledger = await readLedger(opts.ledgerPath, now());
    ledger[opts.requestId] = { id, at: now() };
    await writeLedger(opts.ledgerPath, ledger);
  } catch {
    return result(id, nodeId, `Added the note to ${where}, but could not record it, so a retry would add it again.`);
  }
  return result(id, nodeId, `Added the note to ${where}.`);
}
