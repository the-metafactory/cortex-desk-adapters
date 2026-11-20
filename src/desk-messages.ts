import { isRecord } from "./guards";

export type DeskMessages = { system: string; user: string };

export function readDeskMessages(body: unknown): DeskMessages {
  const list = isRecord(body) ? body.messages : undefined;
  if (!Array.isArray(list)) throw new Error("request needs messages");
  const content = (role: string) => {
    const found = list.find((m): m is { content: string } => isRecord(m) && m.role === role && typeof m.content === "string" && m.content.trim().length > 0);
    if (found === undefined) throw new Error(`request messages need a ${role} message`);
    return found.content;
  };
  return { system: content("system"), user: content("user") };
}
