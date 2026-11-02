// Compaction: summarize everything before the latest user turn into one summary message;
// that turn and everything after it stay verbatim.

import {
  addTokens,
  type MessageInfo,
  type MessageWithParts,
  ModelError,
  type ModelMessage,
  type ModelRequest,
  newId,
  type Part,
  type SessionInfo,
  type Tokens,
  zeroTokens,
} from "@exa/protocol";
import { toModelMessages, visibleHistory } from "../context/context.ts";
import { mergeSameRole, userText } from "./model-messages.ts";
import { collectPatchedFiles, newPart } from "./parts.ts";
import type { LoopRuntime } from "./runtime.ts";

// ---------- constants ----------
const COMPACTION_AGENT = "compaction";
const SUMMARY_MAX_TOKENS = 4096;
const DEFAULT_INSTRUCTION = "Summarize the conversation above following your instructions.";
/** Below this many messages before the tail there is nothing worth summarizing. */
const MIN_MESSAGES_TO_COMPACT = 2;

// ---------- types ----------
interface Summary {
  text: string;
  usage: Partial<Tokens>;
  cost: number;
}

/** Visible history split at the latest real (non-summary) user message. */
interface CompactionSplit {
  head: MessageWithParts[];
  /** First message kept verbatim, or null when everything is summarized. */
  tailStartId: string | null;
}

// ---------- compaction ----------
/** Returns `history` unchanged when there is nothing to compact or the summary came back empty. */
export async function compactHistory(
  rt: LoopRuntime,
  session: SessionInfo,
  history: MessageWithParts[],
  signal: AbortSignal,
  auto: boolean,
): Promise<MessageWithParts[]> {
  const { head, tailStartId } = splitForCompaction(history);
  if (head.length < MIN_MESSAGES_TO_COMPACT) return history;
  const agent = rt.deps.agents.require(COMPACTION_AGENT);
  const { model, tier } = rt.resolveModel(session, agent);
  const messages = await buildSummaryMessages(rt, session.id, head);
  const req: ModelRequest = {
    model,
    system: agent.prompt,
    messages,
    maxTokens: SUMMARY_MAX_TOKENS,
    tier,
    sessionId: session.id,
  };
  const summary = await streamSummary(rt, req, signal);
  if (!summary.text.trim()) return history;
  const text = withModifiedFiles(summary.text, head);

  const parentId = history[history.length - 1]?.info.id ?? null;
  const message = summaryMessage({ sessionId: session.id, parentId, model, summary });
  const parts: Part[] = [
    newPart(message, "text", { text: text.trim() }),
    newPart(message, "compaction", { auto, tailStartId }),
  ];
  await persistSummary(rt, session, message, parts);
  return [...history, { info: message, parts }];
}

// ---------- helpers ----------
function splitForCompaction(history: MessageWithParts[]): CompactionSplit {
  const visible = visibleHistory(history, null);
  let tailIdx = -1;
  for (let i = visible.length - 1; i >= 0; i--) {
    if (visible[i].info.role === "user" && !visible[i].info.summary) {
      tailIdx = i;
      break;
    }
  }
  if (tailIdx > 0)
    return { head: visible.slice(0, tailIdx), tailStartId: visible[tailIdx].info.id };
  return { head: visible, tailStartId: null };
}

/** The head as model messages plus the instruction (a `session.compacting` hook may replace it). */
async function buildSummaryMessages(
  rt: LoopRuntime,
  sessionId: string,
  head: MessageWithParts[],
): Promise<ModelMessage[]> {
  const out = { context: [] as string[], prompt: undefined as string | undefined };
  await rt.hooks.run("session.compacting", { sessionId }, out);
  const instruction = out.prompt ?? [DEFAULT_INSTRUCTION, ...out.context].join("\n\n");
  const messages = toModelMessages(head);
  messages.push(userText(instruction));
  mergeSameRole(messages);
  return messages;
}

async function streamSummary(
  rt: LoopRuntime,
  req: ModelRequest,
  signal: AbortSignal,
): Promise<Summary> {
  const summary: Summary = { text: "", usage: {}, cost: 0 };
  for await (const c of rt.deps.model.stream(req, signal)) {
    if (c.type === "text-delta") summary.text += c.text;
    else if (c.type === "finish") {
      summary.usage = c.usage ?? {};
      summary.cost = c.cost ?? 0;
    } else if (c.type === "error") throw new ModelError(c.message, c.status ?? 0);
  }
  return summary;
}

/** Carry file-change knowledge forward: the summarized patches are gone from the context. */
function withModifiedFiles(summary: string, head: MessageWithParts[]): string {
  const files = collectPatchedFiles(head);
  if (!files.length) return summary;
  return `${summary}\n\nFiles modified so far:\n${files.map((f) => `- ${f}`).join("\n")}`;
}

function summaryMessage(opts: {
  sessionId: string;
  parentId: string | null;
  model: string;
  summary: Summary;
}): MessageInfo {
  const { sessionId, parentId, model, summary } = opts;
  const now = Date.now();
  return {
    id: newId(),
    sessionId,
    parentId,
    role: "user",
    agent: COMPACTION_AGENT,
    model,
    time: { created: now, completed: now },
    tokens: addTokens(zeroTokens(), summary.usage),
    cost: summary.cost,
    summary: true,
  };
}

async function persistSummary(
  rt: LoopRuntime,
  session: SessionInfo,
  message: MessageInfo,
  parts: Part[],
): Promise<void> {
  const { store } = rt.deps;
  await store.putMessage(message);
  await store.putParts(parts);
  session.cost += message.cost;
  await store.updateSession(session.id, { cost: session.cost });
  rt.emit("message.updated", session.id, { info: message });
  for (const p of parts) rt.emit("message.part.updated", session.id, { part: p });
  rt.emit("session.compacted", session.id, { messageId: message.id });
}
