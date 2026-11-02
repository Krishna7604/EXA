// Shared internals of one AgentLoop (deps, resolved config, hooks, deferred-tool state and the
// event emitter) handed to the step, tool, compaction and revert modules.

import {
  type EventPayloads,
  type EventType,
  makeEvent,
  type SessionInfo,
  type Tier,
} from "@exa/protocol";
import { HookRunner } from "../hooks/hooks.ts";
import type { AgentDef } from "../models/agent.model.ts";
import type { LoopDeps } from "../models/loop.model.ts";
import type { ToolSpec } from "../models/tool.model.ts";
import { DEFAULT_LOOP_CONFIG, type LoopConfig } from "./loop.config.ts";

// ---------- constants ----------
const EXA_ROUTER_MODEL = "exa";

// ---------- types ----------
/** Per session: deferred tools currently available, and the ones the model has loaded. */
export interface DeferredTools {
  all: ToolSpec[];
  loaded: Set<string>;
}

export interface ResolvedModel {
  model: string;
  tier?: Tier;
}

// ---------- loop runtime ----------
export class LoopRuntime {
  readonly cfg: LoopConfig;
  readonly hooks: HookRunner;
  readonly deferred = new Map<string, DeferredTools>();

  constructor(readonly deps: LoopDeps) {
    this.cfg = { ...DEFAULT_LOOP_CONFIG, ...deps.config };
    this.hooks = deps.hooks ?? new HookRunner();
  }

  emit<T extends EventType>(type: T, sessionId: string, data: EventPayloads[T]): void {
    this.deps.events.publish(makeEvent(type, sessionId, data));
  }

  async requireSession(sessionId: string): Promise<SessionInfo> {
    const session = await this.deps.store.getSession(sessionId);
    if (!session) throw new Error(`session ${sessionId} not found`);
    return session;
  }

  contextLimit(model: string): number {
    const limit = this.cfg.contextLimit;
    return typeof limit === "function" ? limit(model) : limit;
  }

  /** Explicit override > agent model > `exa/<tier>` on the exa router > session model. */
  resolveModel(session: SessionInfo, agent: AgentDef, override?: string): ResolvedModel {
    if (override) return { model: override, tier: agent.tier };
    if (agent.model) return { model: agent.model, tier: agent.tier };
    const base = session.model;
    if (agent.tier && isExaRouterModel(base)) {
      return { model: `${EXA_ROUTER_MODEL}/${agent.tier}`, tier: agent.tier };
    }
    return { model: base, tier: agent.tier };
  }
}

// ---------- helpers ----------
function isExaRouterModel(model: string): boolean {
  return model === EXA_ROUTER_MODEL || model.startsWith(`${EXA_ROUTER_MODEL}/`);
}
