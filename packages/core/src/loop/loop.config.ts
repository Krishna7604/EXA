// Agent loop configuration: the tunables and their defaults.

// ---------- constants ----------
export const DEFAULT_LOOP_CONFIG: LoopConfig = {
  maxSteps: 50,
  maxCostUsd: 0,
  maxTokens: 8192,
  contextLimit: 128_000,
  compactThreshold: 0.8,
  autoCompact: true,
  maxDepth: 1,
  retries: 2,
  retryBaseMs: 500,
  autoTitle: true,
  deferThreshold: 20,
};

// ---------- types ----------
export interface LoopConfig {
  maxSteps: number;
  /** Per prompt run, USD. 0 = unlimited. */
  maxCostUsd: number;
  maxTokens: number;
  /** Context window used for auto-compaction decisions. */
  contextLimit: number | ((model: string) => number);
  /** Compact when the last request's input exceeds this fraction of the window. */
  compactThreshold: number;
  autoCompact: boolean;
  /** Max subagent nesting (OpenCode default 1: primaries may delegate, subagents may not). */
  maxDepth: number;
  retries: number;
  retryBaseMs: number;
  autoTitle: boolean;
  /** Above this many deferrable (MCP) tools, send names only and let the model load schemas via tool_search. */
  deferThreshold: number;
}
