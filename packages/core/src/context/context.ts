// Context assembly: system prompt + history → provider-neutral ModelMessages.

import type {
  ContentBlock,
  MemoryItem,
  MessageWithParts,
  ModelMessage,
  Part,
  SessionInfo,
  ToolPart,
} from "@exa/protocol";
import type { AgentDef } from "../models/agent.model.ts";
import type { EnvInfo, SkillInfo } from "../models/ports.model.ts";

// ---------- constants ----------
const SKILLS_INTRO =
  "Skills provide specialized instructions loaded on demand. When a task matches a skill's description, call the skill tool with its name before starting.";
const SUMMARY_PREFIX = "Summary of the conversation so far:\n";
const MEMORY_INTRO =
  "What you remember about the user from earlier conversations, newest first. Use it when it helps; don't recite it unprompted. When you learn a lasting fact or preference, or one of these changes, save it with memory_save (pass the id to update one); forget it with memory_forget when the user asks or it turns out wrong.";
/** Memory block cap, so a large memory never crowds out the conversation. */
const MAX_MEMORY_PROMPT_CHARS = 6000;
const INTERRUPTED_TOOL_OUTPUT = "Tool execution was interrupted.";
/** Rough average for English text and code. */
const CHARS_PER_TOKEN = 4;
/** Flat character estimate for an image block. */
const IMAGE_BLOCK_CHARS = 1000;

// ---------- types ----------
type Revert = NonNullable<SessionInfo["revert"]>;

// ---------- context ----------
export function buildSystem(opts: {
  agent: AgentDef;
  env: EnvInfo;
  model: string;
  instructions: Array<{ source: string; content: string }>;
  skills: SkillInfo[];
  subagents: AgentDef[];
  /** Long-term memories; `undefined` when the host has no memory. */
  memories?: MemoryItem[];
  extra?: string[];
}): string[] {
  const out: string[] = [opts.agent.prompt, envSection(opts.env, opts.model)];
  for (const ins of opts.instructions) {
    out.push(`Instructions from ${ins.source}:\n${ins.content.trim()}`);
  }
  if (opts.memories) out.push(memorySection(opts.memories));
  if (opts.skills.length) out.push(skillsSection(opts.skills));
  if (opts.extra) out.push(...opts.extra);
  return out;
}

/** History visible to the model: honours revert markers and compaction. */
export function visibleHistory(
  history: MessageWithParts[],
  session: Pick<SessionInfo, "revert"> | null,
): MessageWithParts[] {
  const msgs = session?.revert ? applyRevert(history, session.revert) : history;
  return applyCompaction(msgs);
}

/**
 * Convert to model messages. Assistant tool calls are followed by a user message carrying
 * the tool results; consecutive same-role messages are merged (Bedrock/Anthropic require
 * alternation); leading assistant turns are dropped (Converse requires a user first).
 */
export function toModelMessages(history: MessageWithParts[]): ModelMessage[] {
  const out: ModelMessage[] = [];
  for (const m of history) {
    if (m.info.role === "user") appendMessage(out, "user", userBlocks(m));
    else appendAssistantSteps(out, m);
  }
  while (out.length && out[0].role !== "user") out.shift();
  return out;
}

/** Rough token estimate (≈4 chars/token) when the provider gives no usage. */
export function estimateTokens(s: string | ModelMessage[]): number {
  if (typeof s === "string") return Math.ceil(s.length / CHARS_PER_TOKEN);
  let chars = 0;
  for (const m of s) for (const b of m.content) chars += blockChars(b);
  return Math.ceil(chars / CHARS_PER_TOKEN);
}

// ---------- helpers ----------
function envSection(env: EnvInfo, model: string): string {
  const branch = env.gitBranch ? ` (branch ${env.gitBranch})` : "";
  const host = env.host === "client" ? "the user's machine" : "a server sandbox";
  return [
    "<env>",
    `Working directory: ${env.cwd}`,
    `Workspace root: ${env.root}`,
    `Is git repo: ${env.isGitRepo ? "yes" : "no"}${branch}`,
    `Platform: ${env.platform}`,
    `Today's date: ${env.date}`,
    `Model: ${model}`,
    `Tools run on: ${host}`,
    "</env>",
  ].join("\n");
}

function memorySection(memories: MemoryItem[]): string {
  const lines: string[] = [];
  let used = 0;
  for (const m of memories) {
    const line = `- [${m.id}] ${m.topic}: ${m.content.replace(/\s+/g, " ")}`;
    used += line.length;
    if (used > MAX_MEMORY_PROMPT_CHARS) break;
    lines.push(line);
  }
  const body = lines.length ? lines.join("\n") : "(nothing saved yet)";
  return `<memory>\n${MEMORY_INTRO}\n${body}\n</memory>`;
}

function skillsSection(skills: SkillInfo[]): string {
  return [
    SKILLS_INTRO,
    "<available_skills>",
    ...skills.map(
      (s) => `  <skill><name>${s.name}</name><description>${s.description}</description></skill>`,
    ),
    "</available_skills>",
  ].join("\n");
}

/** Cut history at the reverted message (or, for a part revert, just before that part). */
function applyRevert(msgs: MessageWithParts[], revert: Revert): MessageWithParts[] {
  const idx = msgs.findIndex((m) => m.info.id === revert.messageId);
  if (idx === -1) return msgs;
  if (!revert.partId) return msgs.slice(0, idx);
  // keep the message up to (excluding) the reverted part
  const target = msgs[idx];
  const partIdx = target.parts.findIndex((p) => p.id === revert.partId);
  const kept = partIdx > 0 ? [{ info: target.info, parts: target.parts.slice(0, partIdx) }] : [];
  return [...msgs.slice(0, idx), ...kept];
}

/** Last compaction: [summary] + tail (from tailStartId, verbatim) + everything after the summary. */
function applyCompaction(msgs: MessageWithParts[]): MessageWithParts[] {
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (!m.info.summary) continue;
    const comp = m.parts.find((p) => p.type === "compaction");
    const tailStart = comp && comp.type === "compaction" ? comp.tailStartId : null;
    const tailIdx = tailStart ? msgs.findIndex((x) => x.info.id === tailStart) : -1;
    const tail = tailIdx !== -1 && tailIdx < i ? msgs.slice(tailIdx, i) : [];
    return [m, ...tail, ...msgs.slice(i + 1)];
  }
  return msgs;
}

/** Appends a message, merging into the previous one when the role repeats. */
function appendMessage(
  out: ModelMessage[],
  role: "user" | "assistant",
  content: ContentBlock[],
): void {
  if (!content.length) return;
  const last = out[out.length - 1];
  if (last && last.role === role) last.content.push(...content);
  else out.push({ role, content: [...content] });
}

function userBlocks(m: MessageWithParts): ContentBlock[] {
  const blocks: ContentBlock[] = [];
  for (const p of m.parts) {
    const block = userPartBlock(p, !!m.info.summary);
    if (block) blocks.push(block);
  }
  return blocks;
}

function userPartBlock(p: Part, isSummary: boolean): ContentBlock | undefined {
  if (p.type === "text" && p.text) {
    return { type: "text", text: isSummary ? `${SUMMARY_PREFIX}${p.text}` : p.text };
  }
  if (p.type !== "file") return undefined;
  if (p.mime.startsWith("image/") && p.url.startsWith("data:")) {
    const data = p.url.slice(p.url.indexOf(",") + 1);
    return { type: "image", mime: p.mime, data };
  }
  return { type: "text", text: `[attached file ${p.filename ?? ""} (${p.mime})]` };
}

/** Assistant: group per step so tool results follow the calls of the same step. */
function appendAssistantSteps(out: ModelMessage[], m: MessageWithParts): void {
  let assistant: ContentBlock[] = [];
  let results: ContentBlock[] = [];
  const flush = () => {
    appendMessage(out, "assistant", assistant);
    appendMessage(out, "user", results);
    assistant = [];
    results = [];
  };
  for (const p of m.parts) {
    if (p.type === "step-start" && (assistant.length || results.length)) flush();
    if (p.type === "text" && p.text.trim()) assistant.push({ type: "text", text: p.text });
    if (p.type === "tool") {
      assistant.push({
        type: "tool-call",
        callId: p.callId,
        name: p.tool,
        input: p.state.input ?? {},
      });
      results.push(toolResultBlock(p));
    }
  }
  flush();
}

function toolResultBlock(p: ToolPart): ContentBlock {
  const base = { type: "tool-result" as const, callId: p.callId, name: p.tool };
  const st = p.state;
  if (st.status === "completed") return { ...base, output: st.output };
  if (st.status === "error") return { ...base, output: st.error, isError: true };
  return { ...base, output: INTERRUPTED_TOOL_OUTPUT, isError: true };
}

function blockChars(b: ContentBlock): number {
  if (b.type === "text") return b.text.length;
  if (b.type === "tool-result") return b.output.length;
  if (b.type === "tool-call") return JSON.stringify(b.input).length;
  return IMAGE_BLOCK_CHARS;
}
