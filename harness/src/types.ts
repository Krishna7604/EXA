// Harness-wide shared types. No runtime code; import with `import type`.
import type { Agent } from "./agent.js";
import type { SessionStore } from "./memory/session.js";
import type { SessionManager } from "./memory/sessions.js";
import type { RunLogger } from "./observability.js";
import type { ConsoleRenderer } from "./renderer.js";
import type { BedrockClient } from "./router/bedrock.js";
import type { Keystore } from "./router/keystore.js";
import type { ModelRouter } from "./router.js";

export type Item =
  | { type: "message"; role: string; text: string; model?: string; correlationId?: string }
  | { type: "function_call"; name: string; args: unknown; correlationId?: string }
  | { type: "function_call_output"; name: string; output: unknown; correlationId?: string };

/** Right-side chat meta: real Bedrock totals on responses, ~estimate on prompts. */
export interface MessageMeta {
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  estimatedTokens?: number;
  costUsd?: number | null;
  ms?: number;
  time?: string;
}

export type Verdict = { allow: true } | { allow: false; reason: string } | { allow: "ask-human"; reason: string };

export interface SubAgentResult {
  task: string;
  correlationId: string;
  status: string;
  result: unknown;
}

export interface AgentConfig {
  model: string;
  maxTokens?: number;
  maxSteps?: number;
  maxCost?: number;
  systemPromptFile?: string;
}

import type { OpenRouterClient } from "./router/openrouter.js";
import type { JevClient } from "./router/typesafe.js";

export interface AgentDeps {
  config: AgentConfig;
  router: ModelRouter;
  session: SessionStore;
  bedrock: BedrockClient;
  openrouter: OpenRouterClient;
  renderer: ConsoleRenderer;
  logger: RunLogger;
}

export interface HarnessConfig extends AgentConfig {
  maxSteps?: number;
  maxCost?: number;
  compactionThreshold?: number;
  fallbacks?: Array<{ model: string }>;
  routing?: { strategy?: string };
}

export interface CliDeps {
  agent: Agent;
  router: ModelRouter;
  keystore: Keystore;
  openrouter: OpenRouterClient;
  jev?: JevClient;
  config: HarnessConfig;
  sessions: SessionManager;
  session: SessionStore;
  renderer: ConsoleRenderer;
}

/** One observability row in runs.jsonl (keys redacted before persist). */
export type RunEntry = Record<string, unknown>;
