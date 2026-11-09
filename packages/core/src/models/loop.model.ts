// Agent loop contract: the dependencies a host injects and the prompt input/result shapes
// of the loop's public API.

import type { FinishReason, PermissionMode, PermissionRule, SessionInfo } from "@exa/protocol";
import type { AgentRegistry } from "../agents/agent-registry.ts";
import type { HookRunner } from "../hooks/hooks.ts";
import type { LoopConfig } from "../loop/loop.config.ts";
import type { ApprovalPort, AuthorizerPort } from "../permission/permission-gate.ts";
import type { ToolRegistry } from "../tool/tool-registry.ts";
import type {
  EnvInfo,
  EventSink,
  InstructionsPort,
  MemoryPort,
  ModelPort,
  SearchPort,
  SessionStore,
  SkillsPort,
  SnapshotPort,
} from "./ports.model.ts";

// ---------- types ----------
export interface PermissionDeps {
  /** builtin + tenant + project + user rules, already ordered by precedence. */
  rules: () => PermissionRule[];
  mode: (session: SessionInfo) => PermissionMode;
  approvals: ApprovalPort;
  authorizer?: AuthorizerPort;
  serverChecked?: Set<string>;
}

export interface LoopDeps {
  model: ModelPort;
  store: SessionStore;
  events: EventSink;
  tools: ToolRegistry;
  agents: AgentRegistry;
  permissions: PermissionDeps;
  env: () => EnvInfo | Promise<EnvInfo>;
  hooks?: HookRunner;
  instructions?: InstructionsPort;
  /** Long-term memory: injected into the system prompt and handed to tools as `services.memory`. */
  memory?: MemoryPort;
  /** Web search, handed to tools as `services.search`. */
  search?: SearchPort;
  skills?: SkillsPort;
  snapshots?: SnapshotPort;
  outputDir: string;
  services?: Record<string, unknown>;
  config?: Partial<LoopConfig>;
}

export interface PromptInput {
  sessionId: string;
  text: string;
  agent?: string;
  model?: string;
  signal?: AbortSignal;
  /** Subagent depth (0 for user prompts). */
  depth?: number;
  files?: Array<{ mime: string; url: string; filename?: string }>;
}

export interface PromptResult {
  messageId: string | null;
  text: string;
  finish: FinishReason;
  error?: { name: string; message: string };
  steps: number;
  cost: number;
}
