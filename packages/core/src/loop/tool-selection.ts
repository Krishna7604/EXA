// Which tools one step offers the model: hides disabled and fully denied tools, defers MCP
// schemas past the threshold, and lists the available subagents on the task tool.

import type { ToolDef } from "@exa/protocol";
import type { AgentDef } from "../models/agent.model.ts";
import type { ToolSpec } from "../models/tool.model.ts";
import type { PermissionEngine } from "../permission/permission-engine.ts";
import type { DeferredTools, LoopRuntime } from "./runtime.ts";

// ---------- constants ----------
const TASK_TOOL = "task";
const TOOL_SEARCH_TOOL = "tool_search";
const DISABLE_ALL = "*";
const DEFERRED_NOTE_INTRO =
  'These tools are available but their schemas are not loaded yet. To use one, first call tool_search with "select:<name>[,<name>]" or keywords; it then becomes callable:';

// ---------- types ----------
export interface StepTools {
  /** Tools whose schemas are sent with the request. */
  offered: ToolSpec[];
  /** Names the model may call this step (deferred ones included). */
  allowed: Set<string>;
  /** System-prompt note listing deferred tools that are not loaded yet. */
  deferredNote?: string;
}

// ---------- tool selection ----------
export function selectStepTools(
  rt: LoopRuntime,
  sessionId: string,
  agent: AgentDef,
  engine: PermissionEngine,
  depth: number,
): StepTools {
  const visible = visibleTools(rt, agent, engine, depth);
  const allowed = new Set(visible.map((t) => t.name));
  const deferrable = visible.filter((t) => t.deferrable);
  if (deferrable.length <= rt.cfg.deferThreshold) {
    return { allowed, offered: visible.filter((t) => t.name !== TOOL_SEARCH_TOOL) };
  }
  const state = trackDeferred(rt, sessionId, deferrable);
  const offered = visible.filter((t) => !t.deferrable || state.loaded.has(t.name));
  const unloaded = deferrable.filter((t) => !state.loaded.has(t.name)).map((t) => t.name);
  const deferredNote = unloaded.length
    ? `${DEFERRED_NOTE_INTRO}\n${unloaded.join(", ")}`
    : undefined;
  return { allowed, offered, deferredNote };
}

/** Model-facing definitions; the task tool's description lists the subagents it may launch. */
export function toolDefinitions(
  rt: LoopRuntime,
  tools: ToolSpec[],
  engine: PermissionEngine,
): ToolDef[] {
  return tools.map((t) => {
    const def = rt.deps.tools.definition(t.name)!;
    if (t.name !== TASK_TOOL) return def;
    const subagents = rt.deps.agents
      .subagents()
      .filter((a) => engine.evaluate(TASK_TOOL, a.name).action !== "deny");
    const list = subagents.map((a) => `- ${a.name}: ${a.description}`).join("\n");
    return { ...def, description: `${def.description}\n\nAvailable agent types:\n${list}` };
  });
}

// ---------- helpers ----------
/** Tools the agent may see: not disabled, not fully denied by permissions. */
function visibleTools(
  rt: LoopRuntime,
  agent: AgentDef,
  engine: PermissionEngine,
  depth: number,
): ToolSpec[] {
  const disabled = new Set(agent.disabledTools ?? []);
  if (disabled.has(DISABLE_ALL)) return [];
  return rt.deps.tools.list().filter((t) => {
    if (disabled.has(t.name)) return false;
    if (t.name === TASK_TOOL && depth >= rt.cfg.maxDepth) return false;
    return !engine.isFullyDenied(t.permissionKey ?? t.name);
  });
}

function trackDeferred(rt: LoopRuntime, sessionId: string, deferrable: ToolSpec[]): DeferredTools {
  const state = rt.deferred.get(sessionId) ?? { all: [], loaded: new Set<string>() };
  state.all = deferrable;
  rt.deferred.set(sessionId, state);
  return state;
}
