// memory_save / memory_forget: the agent keeps the user's long-term memory current. The memory
// itself lives behind the host's MemoryPort (`services.memory`); without one the tools refuse.

import { defineTool, type MemoryPort, type ToolContext } from "@exa/core";
import { z } from "zod";

// ---------- constants ----------
const MEMORY_TOPIC_MAX = 80;
const MEMORY_CONTENT_MAX = 2000;
const NO_MEMORY = "Long-term memory is not available in this session.";

// ---------- memory tools ----------
export const memorySaveTool = defineTool({
  name: "memory_save",
  description:
    "Save a lasting fact or preference about the user to long-term memory, so future conversations can use it. " +
    "Use a short topic (e.g. 'diet', 'work hours', 'family') and one self-contained sentence or two of content. " +
    "To change an existing memory, pass its id (shown in <memory>) instead of saving a duplicate. " +
    "Don't save one-off details, things only true today, or secrets such as passwords and keys.",
  schema: z.object({
    topic: z.string().trim().min(1).max(MEMORY_TOPIC_MAX).describe("Short label"),
    content: z.string().trim().min(1).max(MEMORY_CONTENT_MAX).describe("What to remember"),
    id: z.string().optional().describe("Id of the memory to replace"),
  }),
  readonly: true,
  permissions: (input) => [{ permission: "memory", patterns: [input.topic] }],
  async execute(input, ctx) {
    const memory = memoryOf(ctx);
    if (!memory) return { title: "memory unavailable", output: NO_MEMORY };
    const saved = await memory.save({ ...input, sessionId: ctx.sessionId });
    const verb = input.id ? "Updated" : "Saved";
    return {
      title: `${verb.toLowerCase()} ${saved.topic}`,
      output: `${verb} memory ${saved.id} (${saved.topic}).`,
      metadata: { memory: saved },
    };
  },
});

export const memoryForgetTool = defineTool({
  name: "memory_forget",
  description:
    "Delete a memory by id (ids are shown in <memory>). Use it when the user asks you to forget something or a memory is wrong.",
  schema: z.object({ id: z.string().min(1) }),
  readonly: true,
  permissions: () => [{ permission: "memory", patterns: ["*"] }],
  async execute(input, ctx) {
    const memory = memoryOf(ctx);
    if (!memory) return { title: "memory unavailable", output: NO_MEMORY };
    const isRemoved = await memory.forget(input.id);
    return {
      title: isRemoved ? "forgot memory" : "memory not found",
      output: isRemoved ? `Forgot memory ${input.id}.` : `No memory with id ${input.id}.`,
    };
  },
});

// ---------- helpers ----------
export function memoryOf(ctx: ToolContext): MemoryPort | undefined {
  return ctx.services.memory as MemoryPort | undefined;
}
