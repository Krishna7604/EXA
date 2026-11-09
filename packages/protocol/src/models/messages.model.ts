// Conversation model: a message tree (parentId) whose content is typed parts.
// Parts are persisted in their FINAL state only; deltas travel on the event stream.

// ---------- tokens ----------
export interface Tokens {
  input: number;
  output: number;
  reasoning: number;
  cacheRead: number;
  cacheWrite: number;
}

// ---------- messages ----------
export type Role = "user" | "assistant";

export type FinishReason =
  | "stop"
  | "tool-calls"
  | "length"
  | "error"
  | "aborted"
  | "content-filter";

export interface MessageInfo {
  id: string;
  sessionId: string;
  parentId: string | null;
  role: Role;
  agent: string;
  /** Model requested (e.g. "exa") — `modelUsed` on step-finish is the real backend. */
  model: string;
  time: { created: number; completed?: number };
  tokens: Tokens;
  cost: number;
  finish?: FinishReason;
  /** True for compaction summaries (synthetic user message). */
  summary?: boolean;
  error?: { name: string; message: string };
}

// ---------- parts ----------
interface PartBase {
  id: string;
  messageId: string;
  sessionId: string;
}

export interface TextPart extends PartBase {
  type: "text";
  text: string;
  /** Harness-injected text (reminders, recovery prompts) — shown dimmed, still sent to the model. */
  synthetic?: boolean;
}

export interface ReasoningPart extends PartBase {
  type: "reasoning";
  text: string;
}

export type ToolState =
  | { status: "pending"; input: unknown }
  | { status: "running"; input: unknown; title?: string; time: { start: number } }
  | {
      status: "completed";
      input: unknown;
      output: string;
      title: string;
      metadata: Record<string, unknown>;
      time: { start: number; end: number };
    }
  | { status: "error"; input: unknown; error: string; time: { start: number; end: number } };

export interface ToolPart extends PartBase {
  type: "tool";
  callId: string;
  tool: string;
  state: ToolState;
}

export interface StepStartPart extends PartBase {
  type: "step-start";
  snapshot?: string;
}

export interface StepFinishPart extends PartBase {
  type: "step-finish";
  reason: FinishReason;
  tokens: Tokens;
  cost: number;
  modelUsed?: string;
  snapshot?: string;
}

export interface PatchPart extends PartBase {
  type: "patch";
  files: string[];
  /** Snapshot ref the patch is relative to. */
  hash: string;
}

export interface FilePart extends PartBase {
  type: "file";
  mime: string;
  filename?: string;
  /** data: URL or blob ref. */
  url: string;
}

export interface CompactionPart extends PartBase {
  type: "compaction";
  auto: boolean;
  /** Messages from this id onward are kept verbatim; earlier ones are replaced by the summary. */
  tailStartId: string | null;
}

export type Part =
  | TextPart
  | ReasoningPart
  | ToolPart
  | StepStartPart
  | StepFinishPart
  | PatchPart
  | FilePart
  | CompactionPart;

export type PartType = Part["type"];

export interface MessageWithParts {
  info: MessageInfo;
  parts: Part[];
}

// ---------- sessions ----------
export type StorageMode = "none" | "local" | "server";
export type LoopHost = "client" | "server";

export interface SessionInfo {
  id: string;
  tenantId: string;
  userId: string;
  projectId: string | null;
  parentId: string | null;
  /** Set when this session is a scheduled task's run. */
  taskId?: string | null;
  title: string | null;
  directory: string | null;
  agent: string;
  model: string;
  loopHost: LoopHost;
  storageMode: StorageMode;
  status: "active" | "idle" | "ended";
  revert: { messageId: string; partId?: string; snapshot?: string } | null;
  tokens: Tokens;
  cost: number;
  time: { created: number; updated: number; archived?: number };
}
