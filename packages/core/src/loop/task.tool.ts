// The `task` tool: runs a subagent in a child session; only its final report returns to the parent.

import { makeEvent, newId, type SessionInfo, zeroTokens } from "@exa/protocol";
import { z } from "zod";
import { defineTool } from "../helpers/tool.helper.ts";
import type { AgentDef } from "../models/agent.model.ts";
import type { ToolSpec } from "../models/tool.model.ts";
import type { AgentLoop } from "./agent-loop.ts";

// ---------- constants ----------
const DESCRIPTION =
  "Launch a subagent in its own context to handle a self-contained task (research, tracing code, multi-step work). " +
  "Give a short `description` (3-6 words) and a complete, self-contained `prompt` stating scope, paths and exactly what to return. " +
  "Only the subagent's final report comes back. Launch several in one step to run them in parallel.";
const LABEL_MAX_CHARS = 200;

const TaskInput = z.object({
  description: z
    .string()
    .min(1)
    .max(LABEL_MAX_CHARS)
    .describe("Short (3-6 words) label shown to the user"),
  prompt: z.string().min(1).describe("Full instructions for the subagent"),
  subagent_type: z.string().min(1).describe("Which agent type to use"),
});

// ---------- task tool ----------
/** task: run a subagent in a child session; only its final report returns to the parent. */
export function createTaskTool(loop: AgentLoop): ToolSpec {
  return defineTool({
    name: "task",
    description: DESCRIPTION,
    schema: TaskInput,
    readonly: true,
    permissions: (input) => [
      {
        permission: "task",
        patterns: [input.subagent_type],
        title: `Launch ${input.subagent_type}: ${input.description}`,
      },
    ],
    async execute(input, ctx) {
      const agent = requireSubagent(loop, input.subagent_type);
      if (ctx.depth >= loop.cfg.maxDepth)
        throw new Error("Subagents cannot launch further subagents at this depth.");
      const parent = ctx.services.session as SessionInfo;
      const child = await createChildSession(loop, parent, agent, input.description);
      ctx.update?.({ title: input.description, metadata: { sessionId: child.id } });
      const res = await loop.prompt({
        sessionId: child.id,
        text: input.prompt,
        agent: agent.name,
        depth: ctx.depth + 1,
        signal: ctx.signal,
      });
      if (res.error) throw new Error(`Subagent failed: ${res.error.message}`);
      const report = res.text || "(no output)";
      return {
        title: input.description,
        output: `${report}\n\n<task_metadata>session_id: ${child.id}</task_metadata>`,
        metadata: { sessionId: child.id, steps: res.steps, cost: res.cost },
      };
    },
  });
}

// ---------- helpers ----------
function requireSubagent(loop: AgentLoop, name: string): AgentDef {
  const { agents } = loop.deps;
  const agent = agents.get(name);
  if (agent && agent.mode !== "primary" && !agent.hidden) return agent;
  const available = agents
    .subagents()
    .map((a) => a.name)
    .join(", ");
  throw new Error(`Unknown subagent "${name}". Available: ${available}`);
}

/** Child session inheriting the parent's settings, announced on both sessions' streams. */
async function createChildSession(
  loop: AgentLoop,
  parent: SessionInfo,
  agent: AgentDef,
  title: string,
): Promise<SessionInfo> {
  const now = Date.now();
  const child: SessionInfo = {
    ...parent,
    id: newId(),
    parentId: parent.id,
    title,
    agent: agent.name,
    revert: null,
    tokens: zeroTokens(),
    cost: 0,
    status: "active",
    time: { created: now, updated: now },
  };
  await loop.deps.store.createSession(child);
  loop.deps.events.publish(makeEvent("session.created", parent.id, { info: child }));
  loop.deps.events.publish(makeEvent("session.created", child.id, { info: child }));
  return child;
}
