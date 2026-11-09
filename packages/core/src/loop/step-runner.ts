// Runs the steps of one prompt: each step is one model call plus its tool calls, repeated
// until the model stops calling tools, the step/cost cap is hit, the user rejects, or abort.
//
// Persistence rule: parts are written once, in their final state, at the end of each step
// (one putMessage + one putParts). Streaming deltas only go to the event sink.

import {
  addTokens,
  type FinishReason,
  type MemoryItem,
  type MessageInfo,
  type MessageWithParts,
  type ModelRequest,
  newId,
  type SessionInfo,
  type Tier,
  type Tokens,
  zeroTokens,
} from "@exa/protocol";
import {
  buildSystem,
  estimateTokens,
  toModelMessages,
  visibleHistory,
} from "../context/context.ts";
import type { AgentDef } from "../models/agent.model.ts";
import type { PromptInput, PromptResult } from "../models/loop.model.ts";
import type { EnvInfo, SkillInfo } from "../models/ports.model.ts";
import type { PermissionEngine } from "../permission/permission-engine.ts";
import type { PermissionGate } from "../permission/permission-gate.ts";
import { compactHistory } from "./compaction.ts";
import { ensureNotEmpty, mergeSameRole, userText } from "./model-messages.ts";
import { type ReplyTarget, type StreamedReply, streamReply } from "./model-stream.ts";
import { ABORTED_MESSAGE, newPart, textsOf } from "./parts.ts";
import type { LoopRuntime } from "./runtime.ts";
import type { ToolCallOutcome } from "./tool-call.ts";
import { failToolCalls, runToolCalls } from "./tool-calls.ts";
import { type StepTools, selectStepTools, toolDefinitions } from "./tool-selection.ts";

// ---------- constants ----------
const MAX_STEPS_PROMPT =
  "You have reached the maximum number of steps for this turn. Do not call any tools. Reply with a concise summary of what you accomplished, what remains, and the exact next steps.";
const STREAM_FAILED_MESSAGE = "Not executed: the model stream failed.";
const SKILL_TOOL = "skill";
/** How many memories go into the system prompt (the block is also capped by size). */
const MEMORY_PROMPT_LIMIT = 60;
const NO_TOOL_OUTCOME: ToolCallOutcome = { rejected: false, mutated: false };

// ---------- types ----------
export interface RunContext {
  session: SessionInfo;
  agent: AgentDef;
  history: MessageWithParts[];
  /** The prompt's user message; every assistant message of the run hangs off it. */
  userInfo: MessageInfo;
  gate: PermissionGate;
  signal: AbortSignal;
  input: PromptInput;
  /** The AgentLoop, handed to tools as `services.loop`. */
  loop: unknown;
}

/** Everything resolved once per run, before the first step. */
interface RunSetup {
  model: string;
  tier?: Tier;
  env: EnvInfo;
  instructions: Array<{ source: string; content: string }>;
  skills: SkillInfo[];
  /** Undefined when the host has no long-term memory. */
  memories?: MemoryItem[];
  maxSteps: number;
  depth: number;
}

// ---------- step runner ----------
export async function runSteps(rt: LoopRuntime, ctx: RunContext): Promise<PromptResult> {
  const setup = await prepareRun(rt, ctx);
  return new StepRunner(rt, ctx, setup).run();
}

class StepRunner {
  private readonly recentCalls: string[] = [];
  private history: MessageWithParts[];
  private step = 0;
  private runCost = 0;
  /** Input tokens of the last request; drives auto-compaction. */
  private lastInput: number;
  private finish: FinishReason = "stop";
  private lastError: { name: string; message: string } | undefined;
  private lastAssistantId: string | null = null;
  private finalText = "";

  constructor(
    private readonly rt: LoopRuntime,
    private readonly ctx: RunContext,
    private readonly setup: RunSetup,
  ) {
    this.history = ctx.history;
    // estimate up front so a resumed, already-huge session compacts BEFORE its first call
    this.lastInput = estimateTokens(toModelMessages(visibleHistory(ctx.history, null)));
  }

  async run(): Promise<PromptResult> {
    while (true) {
      if (this.ctx.signal.aborted) {
        this.finish = "aborted";
        break;
      }
      const shouldContinue = await this.runStep();
      if (!shouldContinue) break;
    }
    return {
      messageId: this.lastAssistantId,
      text: this.finalText,
      finish: this.finish,
      error: this.lastError,
      steps: this.step,
      cost: this.runCost,
    };
  }

  /** One model call and its tool calls. Returns whether another step should follow. */
  private async runStep(): Promise<boolean> {
    const { session, agent, gate, signal } = this.ctx;
    const engine = gate.currentEngine;
    const tools = selectStepTools(this.rt, session.id, agent, engine, this.setup.depth);
    const isLast = this.isLastStep();
    await this.compactIfNeeded();
    const req = await this.buildRequest(tools, engine, isLast);
    const target = this.startAssistantMessage();
    const snapshotBefore = await this.startStep(target);
    const reply = await streamReply(this.rt, req, target, signal);
    this.finish = this.recordFinish(reply, target.info);
    const outcome = await this.runTools(reply, target.info, tools.allowed);
    const snapshotAfter = await this.recordPatch(target, outcome.mutated, snapshotBefore);
    const tokens = stepTokens(reply, req);
    this.addStepFinish(target, reply, tokens, snapshotAfter ?? snapshotBefore);
    await this.saveAssistantMessage(target, tokens, reply.cost ?? 0);
    await this.addToSessionTotals(tokens, reply);
    this.endStep(target, tokens, reply.cost ?? 0);

    if (reply.error || outcome.rejected || signal.aborted) return false;
    return reply.calls.length > 0 && !isLast;
  }

  /** The last step gets no tools and is told to wrap up. */
  private isLastStep(): boolean {
    const { maxCostUsd } = this.rt.cfg;
    if (this.step >= this.setup.maxSteps - 1) return true;
    return maxCostUsd > 0 && this.runCost >= maxCostUsd;
  }

  private async compactIfNeeded(): Promise<void> {
    const { cfg } = this.rt;
    if (!cfg.autoCompact) return;
    if (this.lastInput <= this.rt.contextLimit(this.setup.model) * cfg.compactThreshold) return;
    const { session, signal } = this.ctx;
    this.history = await compactHistory(this.rt, session, this.history, signal, true);
    this.lastInput = 0;
  }

  private async buildRequest(
    tools: StepTools,
    engine: PermissionEngine,
    isLast: boolean,
  ): Promise<ModelRequest> {
    const { session, agent } = this.ctx;
    const { model, tier } = this.setup;
    const system = await this.buildSystemPrompt(tools);
    const messages = toModelMessages(visibleHistory(this.history, null));
    if (isLast && this.step > 0) messages.push(userText(MAX_STEPS_PROMPT));
    ensureNotEmpty(messages);
    // merge if the cap prompt landed after a user tool-result message
    mergeSameRole(messages);
    return {
      model,
      system,
      messages,
      tools: isLast ? undefined : toolDefinitions(this.rt, tools.offered, engine),
      maxTokens: this.rt.cfg.maxTokens,
      temperature: agent.temperature,
      tier,
      options: agent.options,
      sessionId: session.id,
    };
  }

  /** System prompt sections, after the `chat.system` hook had its say. */
  private async buildSystemPrompt(tools: StepTools): Promise<string> {
    const { session, agent } = this.ctx;
    const { env, model, instructions, skills, memories } = this.setup;
    const system = buildSystem({
      agent,
      env,
      model,
      instructions,
      memories,
      skills: tools.allowed.has(SKILL_TOOL) ? skills : [],
      subagents: this.rt.deps.agents.subagents(),
      extra: tools.deferredNote ? [tools.deferredNote] : undefined,
    });
    const out = { system };
    await this.rt.hooks.run("chat.system", { sessionId: session.id, agent: agent.name }, out);
    return out.system.join("\n\n");
  }

  private startAssistantMessage(): ReplyTarget {
    const { session, agent, userInfo } = this.ctx;
    const info: MessageInfo = {
      id: newId(),
      sessionId: session.id,
      parentId: userInfo.id,
      role: "assistant",
      agent: agent.name,
      model: this.setup.model,
      time: { created: Date.now() },
      tokens: zeroTokens(),
      cost: 0,
    };
    this.lastAssistantId = info.id;
    this.rt.emit("message.updated", session.id, { info });
    return { info, parts: [] };
  }

  /** Adds the step-start part; returns the workspace snapshot taken before the step. */
  private async startStep(target: ReplyTarget): Promise<string | undefined> {
    const snapshot = await this.rt.deps.snapshots?.track().catch(() => undefined);
    const part = newPart(target.info, "step-start", { snapshot });
    target.parts.push(part);
    this.rt.emit("message.part.updated", this.ctx.session.id, { part });
    return snapshot;
  }

  private recordFinish(reply: StreamedReply, info: MessageInfo): FinishReason {
    if (reply.error) {
      this.lastError = { name: reply.error.name, message: reply.error.message };
      info.error = this.lastError;
      this.rt.emit("session.error", this.ctx.session.id, { error: this.lastError });
    }
    return finishReason(reply, this.ctx.signal.aborted);
  }

  private async runTools(
    reply: StreamedReply,
    info: MessageInfo,
    allowed: Set<string>,
  ): Promise<ToolCallOutcome> {
    const { session, agent, gate, signal, loop } = this.ctx;
    if (!reply.calls.length) return NO_TOOL_OUTCOME;
    if (reply.error || signal.aborted) {
      failToolCalls(reply.calls, signal.aborted ? ABORTED_MESSAGE : STREAM_FAILED_MESSAGE);
      return NO_TOOL_OUTCOME;
    }
    return runToolCalls(this.rt, reply.calls, {
      session,
      agent,
      gate,
      allowed,
      signal,
      depth: this.setup.depth,
      recentCalls: this.recentCalls,
      messageId: info.id,
      loop,
    });
  }

  /** After a mutating step, adds a patch part listing the changed files. */
  private async recordPatch(
    target: ReplyTarget,
    mutated: boolean,
    snapshotBefore: string | undefined,
  ): Promise<string | undefined> {
    const { snapshots } = this.rt.deps;
    if (!mutated || !snapshots || !snapshotBefore) return undefined;
    const snapshotAfter = await snapshots.track().catch(() => undefined);
    const files = await snapshots.changed(snapshotBefore).catch(() => [] as string[]);
    if (files.length) {
      const patch = newPart(target.info, "patch", { files, hash: snapshotBefore });
      target.parts.push(patch);
      this.rt.emit("message.part.updated", this.ctx.session.id, { part: patch });
    }
    return snapshotAfter;
  }

  /** Adds the step-finish part and republishes the final text/reasoning parts. */
  private addStepFinish(
    target: ReplyTarget,
    reply: StreamedReply,
    tokens: Tokens,
    snapshot: string | undefined,
  ): void {
    const sessionId = this.ctx.session.id;
    const part = newPart(target.info, "step-finish", {
      reason: this.finish,
      tokens,
      cost: reply.cost ?? 0,
      modelUsed: reply.modelUsed,
      snapshot,
    });
    target.parts.push(part);
    this.rt.emit("message.part.updated", sessionId, { part });
    for (const p of target.parts) {
      if (p.type === "text" || p.type === "reasoning") {
        this.rt.emit("message.part.updated", sessionId, { part: p });
      }
    }
  }

  private async saveAssistantMessage(
    target: ReplyTarget,
    tokens: Tokens,
    cost: number,
  ): Promise<void> {
    const { info, parts } = target;
    info.time.completed = Date.now();
    info.tokens = tokens;
    info.cost = cost;
    info.finish = this.finish;
    await this.rt.deps.store.putMessage(info);
    await this.rt.deps.store.putParts(parts);
    this.rt.emit("message.updated", info.sessionId, { info });
  }

  private async addToSessionTotals(tokens: Tokens, reply: StreamedReply): Promise<void> {
    const { session } = this.ctx;
    const cost = reply.cost ?? 0;
    session.tokens = addTokens(session.tokens, tokens);
    session.cost += cost;
    session.time.updated = Date.now();
    await this.rt.deps.store.updateSession(session.id, {
      tokens: session.tokens,
      cost: session.cost,
      time: session.time,
    });
    this.rt.emit("session.updated", session.id, {
      info: { id: session.id, tokens: session.tokens, cost: session.cost },
    });
    const model = reply.modelUsed ?? this.setup.model;
    this.rt.emit("usage", session.id, { model, tokens: { ...tokens }, cost });
  }

  private endStep(target: ReplyTarget, tokens: Tokens, cost: number): void {
    this.history.push({ info: target.info, parts: target.parts });
    this.runCost += cost;
    this.lastInput = tokens.input + tokens.cacheRead + tokens.cacheWrite;
    const texts = textsOf(target.parts);
    if (texts.length) this.finalText = texts.join("\n");
    this.step++;
  }
}

// ---------- helpers ----------
async function prepareRun(rt: LoopRuntime, ctx: RunContext): Promise<RunSetup> {
  const { session, agent, input } = ctx;
  const { model, tier } = rt.resolveModel(session, agent, input.model);
  const env = await rt.deps.env();
  const [instructions, skills, memories] = await Promise.all([
    rt.deps.instructions?.load() ?? [],
    rt.deps.skills?.list() ?? [],
    loadMemories(rt),
  ]);
  const maxSteps = agent.steps ?? rt.cfg.maxSteps;
  return { model, tier, env, instructions, skills, memories, maxSteps, depth: input.depth ?? 0 };
}

/** Memories for the system prompt. A memory outage costs the turn its memory, not the turn. */
async function loadMemories(rt: LoopRuntime): Promise<MemoryItem[] | undefined> {
  if (!rt.deps.memory) return undefined;
  try {
    return await rt.deps.memory.list(MEMORY_PROMPT_LIMIT);
  } catch {
    // reported by the host's own logging; the turn goes on without memories
    return [];
  }
}

function finishReason(reply: StreamedReply, isAborted: boolean): FinishReason {
  if (reply.error) return "error";
  if (isAborted) return "aborted";
  if (reply.calls.length) return "tool-calls";
  // the model asked for tools but sent none: treat as a normal stop
  if (reply.reason === "tool-calls") return "stop";
  return reply.reason ?? "stop";
}

/** Reported usage; without a reported input count, estimate it from the request. */
function stepTokens(reply: StreamedReply, req: ModelRequest): Tokens {
  const tokens = addTokens(zeroTokens(), reply.usage);
  if (!reply.usage.input && !reply.error) {
    tokens.input = estimateTokens(req.messages) + estimateTokens(req.system);
  }
  return tokens;
}
