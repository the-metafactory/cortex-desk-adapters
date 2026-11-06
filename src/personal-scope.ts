import { mkdtemp, chmod, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";
import { isRecord } from "./guards";
import type { TriageRequest } from "./triage";

const Snapshot = z.object({
  policy: z.literal("cloud"),
  meetings: z.array(z.object({ key: z.string(), title: z.string(), start: z.string() })),
  notes: z.array(z.object({ id: z.string(), name: z.string(), text: z.string() })),
});
const TOOLS = new Set(["A_MAIL_SEARCH", "A_MAIL_READ", "A_CALENDAR_EVENTS", "A_NOTES_SEARCH"]);

export async function readPersonalScope(input: { scopeFile: string; query?: string }, read: (path: string) => Promise<string>, kind: "calendar" | "notes") {
  const scope = Snapshot.parse(JSON.parse(await read(input.scopeFile)));
  const terms = (input.query ?? "").toLowerCase().split(/\s+/).filter(Boolean);
  const matches = (text: string) => terms.every(term => text.toLowerCase().includes(term));
  const coverage = "Only the supplied cloud-policy Desk calendar and Studio notes were searched. Other calendars and note stores were not queried.";
  return kind === "calendar"
    ? { events: scope.meetings.filter(item => matches([item.title, item.start].join(" "))).slice(0, 20), coverage }
    : { notes: scope.notes.filter(item => matches([item.name, item.text].join(" "))).slice(0, 20), coverage };
}

function scopeResearch(value: unknown, scopeFile: string, account: string, timeoutMs: number): void {
  if (Array.isArray(value)) { value.forEach(item => scopeResearch(item, scopeFile, account, timeoutMs)); return; }
  if (!isRecord(value)) return;
  if (isRecord(value.research)) {
    const step = value.research;
    if (!Array.isArray(step.tools) || step.tools.some(tool => typeof tool !== "string" || !TOOLS.has(tool))) throw new Error("Personal research has an unapproved tool");
    if (step.bind !== undefined) throw new Error("Personal research must not override host bindings");
    step.bind = { scopeFile, account };
    step.timeout_ms = timeoutMs;
  }
  Object.values(value).forEach(item => scopeResearch(item, scopeFile, account, timeoutMs));
}

export async function personalFlow(request: TriageRequest, flow: string, accounts: string[], timeoutMs: number, sources: string[], areas: string[]) {
  const account = request.mail.account;
  if (request.sourcePolicy !== "cloud" || !account || !accounts.includes(account)) throw new Error("Native Codex requires cloud-approved sources and an explicit personal mail account");
  if (!request.mail.sourceId || !sources.includes(request.mail.sourceId)) throw new Error("Mail source is not cloud-approved");
  if (request.meetings.some(item => item.sourcePolicy !== "cloud" || !item.sourceId || !sources.includes(item.sourceId))) throw new Error("Calendar source is not cloud-approved");
  if ((request.notes ?? []).some(item => item.sourcePolicy !== "cloud" || !item.areas?.length || item.areas.some(area => !areas.includes(area)))) throw new Error("Note areas are not cloud-approved");
  const dir = await mkdtemp(join(tmpdir(), "desk-personal-"));
  try {
    await chmod(dir, 0o700);
    const scopeFile = join(dir, "scope.json");
    await Bun.write(scopeFile, JSON.stringify({ policy: "cloud", meetings: request.meetings, notes: request.notes ?? [] }));
    await chmod(scopeFile, 0o600);
    const parsed: unknown = Bun.YAML.parse(await Bun.file(flow).text());
    scopeResearch(parsed, scopeFile, account, timeoutMs);
    const scopedFlow = join(dir, "triage.yaml");
    await Bun.write(scopedFlow, Bun.YAML.stringify(parsed));
    await chmod(scopedFlow, 0o600);
    return { flow: scopedFlow, actionDirs: [join(import.meta.dir, "..", "personal-actions"), dirname(flow)], close: () => rm(dir, { recursive: true, force: true }) };
  } catch (error) { await rm(dir, { recursive: true, force: true }); throw error; }
}
