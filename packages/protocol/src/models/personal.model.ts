// Shapes for the personal-agent features, shared by the server API, the loop's ports and the
// clients: long-term memory, chat search, scheduled tasks, connectors and web search results.

// ---------- memory ----------
/** One remembered fact or preference about the user, filed under a short topic. */
export interface MemoryItem {
  id: string;
  topic: string;
  content: string;
  /** The chat it was learned in; null when added by hand. */
  sourceSessionId: string | null;
  time: { created: number; updated: number };
}

/** A stored chat message that matched a full-text search. */
export interface ChatSearchHit {
  sessionId: string;
  sessionTitle: string | null;
  messageId: string;
  role: "user" | "assistant";
  /** Matching text with the hits wrapped in `<b>…</b>` (everything else escaped). */
  snippet: string;
  time: number;
}

// ---------- scheduled tasks ----------
export type TaskRunStatus = "running" | "ok" | "error";

/** A prompt the server runs on a cron schedule, as the user who owns it. */
export interface ScheduledTask {
  id: string;
  name: string;
  prompt: string;
  /** Five-field cron expression, evaluated in `timezone` (IANA name). */
  schedule: string;
  timezone: string;
  /** Null: the user's default model / the default agent. */
  model: string | null;
  agent: string | null;
  enabled: boolean;
  nextRunAt: number | null;
  lastRunAt: number | null;
  lastStatus: TaskRunStatus | null;
  lastSessionId: string | null;
  time: { created: number; updated: number };
}

/** One execution of a scheduled task; its conversation is the session `sessionId`. */
export interface TaskRun {
  id: string;
  taskId: string;
  sessionId: string | null;
  trigger: "schedule" | "manual";
  status: TaskRunStatus;
  error: string | null;
  cost: number;
  time: { started: number; finished: number | null };
}

// ---------- connectors ----------
/** A remote MCP server the server-side agent can use. Secret headers are never returned. */
export interface Connector {
  id: string;
  name: string;
  scope: "user" | "tenant";
  url: string;
  enabled: boolean;
  /** Names of the secret headers stored for it (values are write-only). */
  secretHeaders: string[];
  time: { created: number; updated: number };
}

// ---------- web search ----------
export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  /** ISO date when the provider reports one. */
  published?: string;
}
