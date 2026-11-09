// Executes one tool call: validate → doom-loop check → before hook → permission gate → run →
// truncate output → after hook. The ToolPart's state is updated in place to its final state.

import { canonicalJson, type SessionInfo, type ToolPart } from "@exa/protocol";
import type { z } from "zod";
import { truncateOutput } from "../helpers/output.helper.ts";
import { formatZodError } from "../helpers/tool.helper.ts";
import type { AgentDef } from "../models/agent.model.ts";
import type { ToolContext, ToolSpec } from "../models/tool.model.ts";
import { PermissionDeniedError, PermissionRejectedError } from "../permission/permission-engine.ts";
import type { PermissionAsk, PermissionGate } from "../permission/permission-gate.ts";
import { ABORTED_MESSAGE, failToolPart } from "./parts.ts";
import type { LoopRuntime } from "./runtime.ts";

// ---------- constants ----------
/** This many identical calls in a row asks the user whether to continue. */
const DOOM_LOOP_REPEATS = 3;
const DOOM_LOOP_PERMISSION = "doom_loop";
/** Outcome of a call that failed before it could touch anything. */
const NOT_RUN: ToolCallOutcome = { rejected: false, mutated: false };

// ---------- types ----------
export interface ToolCallContext {
  session: SessionInfo;
  agent: AgentDef;
  gate: PermissionGate;
  /** Tool names the model may call this step. */
  allowed: Set<string>;
  signal: AbortSignal;
  depth: number;
  /** Signatures of the latest calls of this run (shared across steps) for doom-loop detection. */
  recentCalls: string[];
  messageId: string;
  /** The AgentLoop, handed to tools as `services.loop`. */
  loop: unknown;
}

export interface ToolCallOutcome {
  /** The user rejected a permission: the rest of the step is skipped. */
  rejected: boolean;
  /** The tool may have changed the workspace (snapshot diff needed). */
  mutated: boolean;
}

/** A validated call about to run. */
interface PreparedCall {
  part: ToolPart;
  spec: ToolSpec;
  input: unknown;
  toolCtx: ToolContext;
  ctx: ToolCallContext;
}

// ---------- tool call ----------
export async function executeToolCall(
  rt: LoopRuntime,
  part: ToolPart,
  ctx: ToolCallContext,
): Promise<ToolCallOutcome> {
  const start = Date.now();
  const spec = rt.deps.tools.get(part.tool);
  if (!spec || !ctx.allowed.has(part.tool)) {
    const available = [...ctx.allowed].join(", ");
    failToolPart(
      part,
      `Unknown or unavailable tool "${part.tool}". Available tools: ${available}`,
      start,
    );
    return NOT_RUN;
  }
  const parsed = spec.schema.safeParse(part.state.input ?? {});
  if (!parsed.success) {
    const issues = formatZodError(parsed.error as z.ZodError);
    failToolPart(
      part,
      `Invalid arguments for ${spec.name}: ${issues}. Fix the arguments and call again.`,
      start,
    );
    return NOT_RUN;
  }
  const toolCtx = await buildToolContext(rt, part, ctx);
  const call: PreparedCall = { part, spec, input: parsed.data, toolCtx, ctx };
  try {
    await runPreparedCall(rt, call, start);
    return { rejected: false, mutated: !spec.readonly };
  } catch (e) {
    return failedOutcome(call, e, start);
  }
}

// ---------- helpers ----------
async function runPreparedCall(rt: LoopRuntime, call: PreparedCall, start: number): Promise<void> {
  const { part, spec, toolCtx, ctx } = call;
  await checkDoomLoop(call);
  const args = await runBeforeHook(rt, call);
  await checkPermissions(call, args);
  part.state = { status: "running", input: part.state.input, time: { start } };
  rt.emit("message.part.updated", ctx.session.id, { part });
  const result = await spec.execute(args, toolCtx);
  const trunc = await truncateOutput(result.output, toolCtx);
  const out = { result: { ...result, output: trunc.output } };
  await rt.hooks.run("tool.execute.after", { ...hookInput(call), args }, out);
  part.state = {
    status: "completed",
    input: part.state.input,
    output: out.result.output,
    title: out.result.title,
    metadata: {
      ...out.result.metadata,
      truncated: trunc.truncated,
      ...(trunc.fullPath ? { outputPath: trunc.fullPath } : {}),
    },
    time: { start, end: Date.now() },
  };
}

async function buildToolContext(
  rt: LoopRuntime,
  part: ToolPart,
  ctx: ToolCallContext,
): Promise<ToolContext> {
  const env = await rt.deps.env();
  return {
    sessionId: ctx.session.id,
    messageId: ctx.messageId,
    callId: part.callId,
    agent: ctx.agent.name,
    root: env.root,
    cwd: env.cwd,
    signal: ctx.signal,
    outputDir: rt.deps.outputDir,
    depth: ctx.depth,
    services: {
      ...rt.deps.services,
      memory: rt.deps.memory,
      search: rt.deps.search,
      session: ctx.session,
      loop: ctx.loop,
    },
    update: (u) => {
      if (part.state.status !== "running") return;
      if (u.title) part.state.title = u.title;
      rt.emit("message.part.updated", ctx.session.id, { part });
    },
  };
}

/** Asks the user to confirm once the same call has been made DOOM_LOOP_REPEATS times in a row. */
async function checkDoomLoop(call: PreparedCall): Promise<void> {
  const { spec, ctx } = call;
  const signature = `${spec.name}:${canonicalJson(call.input)}`;
  ctx.recentCalls.push(signature);
  if (ctx.recentCalls.length > DOOM_LOOP_REPEATS) ctx.recentCalls.shift();
  const isRepeating =
    ctx.recentCalls.length === DOOM_LOOP_REPEATS && ctx.recentCalls.every((s) => s === signature);
  if (!isRepeating) return;
  const ask: PermissionAsk = {
    permission: DOOM_LOOP_PERMISSION,
    patterns: [spec.name],
    title: `${spec.name} called ${DOOM_LOOP_REPEATS}× with identical input — continue?`,
  };
  await ctx.gate.check(ask, gateContext(call, call.input));
}

/** Runs `tool.execute.before`; hooks may rewrite the arguments. */
async function runBeforeHook(rt: LoopRuntime, call: PreparedCall): Promise<unknown> {
  const holder = { args: call.input };
  await rt.hooks.run("tool.execute.before", hookInput(call), holder);
  return holder.args;
}

async function checkPermissions(call: PreparedCall, args: unknown): Promise<void> {
  const asks = await call.spec.permissions(args, call.toolCtx);
  for (const ask of asks) await call.ctx.gate.check(ask, gateContext(call, args));
}

function failedOutcome(call: PreparedCall, e: unknown, start: number): ToolCallOutcome {
  const { part, spec, ctx } = call;
  if (e instanceof PermissionRejectedError) {
    failToolPart(part, e.message, start);
    return { rejected: true, mutated: false };
  }
  if (e instanceof PermissionDeniedError) {
    failToolPart(part, e.message, start);
    return NOT_RUN;
  }
  const message = ctx.signal.aborted ? ABORTED_MESSAGE : `${(e as Error)?.message ?? String(e)}`;
  failToolPart(part, message, start);
  return { rejected: false, mutated: !spec.readonly };
}

function hookInput(call: PreparedCall) {
  return {
    tool: call.spec.name,
    sessionId: call.ctx.session.id,
    callId: call.part.callId,
    agent: call.ctx.agent.name,
  };
}

function gateContext(call: PreparedCall, input: unknown) {
  return {
    tool: call.spec.name,
    callId: call.part.callId,
    messageId: call.ctx.messageId,
    input,
    signal: call.ctx.signal,
  };
}
