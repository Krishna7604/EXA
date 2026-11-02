// todowrite: replace the session's task list and publish it as a `todo.updated` event.

import { type AgentLoop, defineTool } from "@exa/core";
import { makeEvent } from "@exa/protocol";
import { z } from "zod";

// ---------- constants ----------
const MAX_TODOS = 100;
const STATUS_MARKS = {
  pending: "[ ]",
  in_progress: "[~]",
  completed: "[x]",
  cancelled: "[-]",
} as const;

// ---------- types ----------
export interface Todo {
  content: string;
  status: "pending" | "in_progress" | "completed" | "cancelled";
  priority?: "high" | "medium" | "low";
}

// ---------- todo store ----------
export class TodoStore {
  private readonly todos = new Map<string, Todo[]>();

  get(sessionId: string): Todo[] {
    return this.todos.get(sessionId) ?? [];
  }

  set(sessionId: string, t: Todo[]): void {
    this.todos.set(sessionId, t);
  }
}

// ---------- todo tool ----------
export const todoTool = defineTool({
  name: "todowrite",
  description:
    "Create or update the task list for the current work (replaces the whole list). Use it for multi-step tasks (3+ steps) to plan and show progress: " +
    "exactly one item in_progress at a time; mark items completed as soon as they are done.",
  schema: z.object({
    todos: z
      .array(
        z.object({
          content: z.string().min(1),
          status: z.enum(["pending", "in_progress", "completed", "cancelled"]),
          priority: z.enum(["high", "medium", "low"]).optional(),
        }),
      )
      .max(MAX_TODOS),
  }),
  readonly: true,
  permissions: () => [{ permission: "todowrite", patterns: ["*"] }],
  async execute(input, ctx) {
    const store = (ctx.services.todos as TodoStore | undefined) ?? new TodoStore();
    store.set(ctx.sessionId, input.todos);
    const loop = ctx.services.loop as AgentLoop | undefined;
    loop?.deps.events.publish(makeEvent("todo.updated", ctx.sessionId, { todos: input.todos }));
    const open = input.todos.filter(isOpen).length;
    return {
      output:
        input.todos.map((t) => `${STATUS_MARKS[t.status]} ${t.content}`).join("\n") || "(empty)",
      title: `${open} open todo${open === 1 ? "" : "s"}`,
      metadata: { todos: input.todos },
    };
  },
});

// ---------- helpers ----------
function isOpen(t: Todo): boolean {
  return t.status !== "completed" && t.status !== "cancelled";
}
