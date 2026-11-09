// recall: search the user's long-term memory and their past stored chats ("what did we decide
// about the trip?"). Read-only; backed by the host's MemoryPort (`services.memory`).

import { defineTool, type MemoryPort } from "@exa/core";
import type { ChatSearchHit, MemoryItem } from "@exa/protocol";
import { z } from "zod";
import { memoryOf } from "./memory.tool.ts";

// ---------- constants ----------
const DEFAULT_LIMIT = 8;
const MAX_LIMIT = 25;
const HTML_ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
};

// ---------- recall tool ----------
export const recallTool = defineTool({
  name: "recall",
  description:
    "Search what you know from before: the user's saved memories and the text of their past conversations. " +
    "Use it when the user refers to something from an earlier chat, or before asking them for something they may have told you already. " +
    "Keyword search: use the distinctive words you expect to appear.",
  schema: z.object({
    query: z.string().trim().min(1).max(300),
    in: z.enum(["memory", "chats", "both"]).default("both"),
    limit: z.number().int().min(1).max(MAX_LIMIT).default(DEFAULT_LIMIT),
  }),
  readonly: true,
  permissions: () => [{ permission: "recall", patterns: ["*"] }],
  async execute(input, ctx) {
    const memory = memoryOf(ctx);
    if (!memory) return { title: "recall unavailable", output: "Recall is not available here." };
    const [memories, chats] = await Promise.all([
      input.in === "chats" ? [] : memory.search(input.query, input.limit),
      input.in === "memory" ? [] : searchChats(memory, input.query, input.limit),
    ]);
    const sections = [memorySection(memories), chatSection(chats)].filter(Boolean);
    const found = memories.length + chats.length;
    return {
      title: `${input.query} · ${found} found`,
      output: sections.length ? sections.join("\n\n") : `Nothing found for "${input.query}".`,
    };
  },
});

// ---------- helpers ----------
async function searchChats(m: MemoryPort, query: string, limit: number) {
  return m.searchChats ? m.searchChats(query, limit) : [];
}

function memorySection(items: MemoryItem[]): string {
  if (!items.length) return "";
  return ["Memories:", ...items.map((m) => `- [${m.id}] ${m.topic}: ${m.content}`)].join("\n");
}

function chatSection(hits: ChatSearchHit[]): string {
  if (!hits.length) return "";
  const lines = hits.map((h) => {
    const day = new Date(h.time).toISOString().slice(0, 10);
    const title = h.sessionTitle ?? "Untitled chat";
    return `- "${title}" (${day}, ${h.role}, session ${h.sessionId}): ${plainSnippet(h.snippet)}`;
  });
  return ["Past chats:", ...lines].join("\n");
}

/** Snippets come HTML-escaped with `<b>` around hits; the model gets plain text with **hits**. */
function plainSnippet(snippet: string): string {
  const marked = snippet.replace(/<\/?b>/g, "**");
  return marked.replace(/&(amp|lt|gt|quot|#39);/g, (e) => HTML_ENTITIES[e] ?? e);
}
