// Records the user's prompt (text plus attached files) as a persisted, published user message.

import {
  type MessageInfo,
  type MessageWithParts,
  newId,
  type Part,
  type SessionInfo,
  zeroTokens,
} from "@exa/protocol";
import type { AgentDef } from "../models/agent.model.ts";
import type { PromptInput } from "../models/loop.model.ts";
import { newPart } from "./parts.ts";
import type { LoopRuntime } from "./runtime.ts";

// ---------- user message ----------
/** Persists and publishes the user message, then appends it to `history`. */
export async function appendUserMessage(
  rt: LoopRuntime,
  history: MessageWithParts[],
  opts: { session: SessionInfo; agent: AgentDef; input: PromptInput; text: string },
): Promise<MessageInfo> {
  const { session, agent, input } = opts;
  const now = Date.now();
  const info: MessageInfo = {
    id: newId(),
    sessionId: session.id,
    parentId: history.length ? history[history.length - 1].info.id : null,
    role: "user",
    agent: agent.name,
    model: input.model ?? session.model,
    time: { created: now, completed: now },
    tokens: zeroTokens(),
    cost: 0,
  };
  const parts: Part[] = [newPart(info, "text", { text: opts.text })];
  for (const f of input.files ?? []) {
    parts.push(newPart(info, "file", { mime: f.mime, url: f.url, filename: f.filename }));
  }
  await rt.deps.store.putMessage(info);
  await rt.deps.store.putParts(parts);
  rt.emit("message.updated", session.id, { info });
  for (const p of parts) rt.emit("message.part.updated", session.id, { part: p });
  history.push({ info, parts });
  return info;
}
