export interface ChatModel {
  readonly label: string;
  complete(request: unknown, options?: { signal?: AbortSignal }): Promise<unknown>;
}

export type ResearchEvent =
  | { type: "research.started"; name: string; model: string; tools: string[] }
  | { type: "research.round"; name: string; round: number; tool_calls: string[] }
  | { type: "research.completed"; name: string; stats: unknown }
  | { type: "research.failed"; name: string; error: string; unavailable: boolean };

export interface PipelineResult {
  success: boolean;
  output?: Record<string, unknown>;
  error?: string;
  cause?: unknown;
}

export interface FlowOptions {
  models: Record<string, ChatModel>;
  actionDirs: string[];
  transcriptDir: string;
  onResearchEvent: (event: ResearchEvent) => void;
}

export type FlowRunner = (path: string, input: Record<string, unknown>, options: FlowOptions) => Promise<PipelineResult>;

export interface OpenAICompatibleConfig {
  baseUrl: string;
  model: string;
  apiKeyEnv: string;
  label?: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

interface PulseApi {
  runPipelineFromYaml: FlowRunner;
  OpenAICompatibleChatModel: new (config: OpenAICompatibleConfig) => ChatModel;
  ResearchUnavailable: new (...args: never[]) => Error & { reason: string };
  MapItemFailure: new (...args: never[]) => Error & { original?: unknown };
  ModelUnavailableError: new (model: string, reason: string, extra?: { unreachable?: boolean }) => Error;
}

const specifier: string = "pulse";

const MEMBERS = ["runPipelineFromYaml", "OpenAICompatibleChatModel", "ResearchUnavailable", "MapItemFailure", "ModelUnavailableError"] as const;

export function asPulseApi(mod: Record<string, unknown>): PulseApi {
  const missing = MEMBERS.filter((m) => typeof mod[m] !== "function");
  if (missing.length > 0) throw new Error(`pulse lacks ${missing.join(", ")}; this adapter expects pulse v0.31`);
  return mod as unknown as PulseApi;
}

export const pulse = asPulseApi((await import(specifier)) as Record<string, unknown>);
