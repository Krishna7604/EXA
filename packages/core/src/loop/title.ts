// Session auto-title: the hidden "title" agent names the session from the first user message.

import type { ModelRequest, SessionInfo } from "@exa/protocol";
import { userText } from "./model-messages.ts";
import type { LoopRuntime } from "./runtime.ts";

// ---------- constants ----------
const TITLE_AGENT = "title";
const TITLE_MAX_TOKENS = 40;
const FIRST_MESSAGE_MAX_CHARS = 4000;
const TITLE_MAX_CHARS = 80;
/** Leading quotes/hashes and trailing quotes/periods the model tends to add. */
const TITLE_DECORATION = /^["'#\s]+|["'.\s]+$/g;

// ---------- title ----------
export async function generateTitle(
  rt: LoopRuntime,
  session: SessionInfo,
  firstMessage: string,
): Promise<void> {
  const agent = rt.deps.agents.get(TITLE_AGENT);
  if (!agent) return;
  const { model, tier } = rt.resolveModel(session, agent);
  const req: ModelRequest = {
    model,
    system: agent.prompt,
    messages: [userText(firstMessage.slice(0, FIRST_MESSAGE_MAX_CHARS))],
    maxTokens: TITLE_MAX_TOKENS,
    tier,
    sessionId: session.id,
  };
  const raw = await streamTitle(rt, req);
  if (raw === null) return;
  const title = cleanTitle(raw);
  if (!title) return;
  session.title = title;
  await rt.deps.store.updateSession(session.id, { title });
  rt.emit("session.updated", session.id, { info: { id: session.id, title } });
}

// ---------- helpers ----------
/** The streamed text, or null when the model reported an error. */
async function streamTitle(rt: LoopRuntime, req: ModelRequest): Promise<string | null> {
  let title = "";
  for await (const c of rt.deps.model.stream(req, new AbortController().signal)) {
    if (c.type === "text-delta") title += c.text;
    if (c.type === "error") return null;
  }
  return title;
}

function cleanTitle(raw: string): string {
  return raw.split("\n")[0].replace(TITLE_DECORATION, "").slice(0, TITLE_MAX_CHARS);
}
