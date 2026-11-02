// question: ask the attached user multiple-choice questions when the agent is blocked.

import { defineTool } from "@exa/core";
import { z } from "zod";

// ---------- constants ----------
const MIN_OPTIONS = 2;
const MAX_OPTIONS = 6;
const MAX_QUESTIONS = 4;

// ---------- types ----------
export interface QuestionPort {
  ask(
    sessionId: string,
    questions: Array<{ question: string; options: string[]; multiple?: boolean }>,
    signal: AbortSignal,
  ): Promise<string[][]>;
}

// ---------- question tool ----------
export const questionTool = defineTool({
  name: "question",
  description:
    "Ask the user one or more multiple-choice questions when you are blocked on a decision only they can make. " +
    "Do not use it for things you can determine from the code or sensible defaults.",
  schema: z.object({
    questions: z
      .array(
        z.object({
          question: z.string().min(1),
          options: z.array(z.string().min(1)).min(MIN_OPTIONS).max(MAX_OPTIONS),
          multiple: z.boolean().optional(),
        }),
      )
      .min(1)
      .max(MAX_QUESTIONS),
  }),
  readonly: true,
  permissions: () => [{ permission: "question", patterns: ["*"] }],
  async execute(input, ctx) {
    const port = ctx.services.questions as QuestionPort | undefined;
    if (!port)
      throw new Error(
        "No interactive user is attached; make a reasonable assumption and state it.",
      );
    const answers = await port.ask(ctx.sessionId, input.questions, ctx.signal);
    const out = input.questions
      .map((q, i) => `Q: ${q.question}\nA: ${formatAnswer(answers[i])}`)
      .join("\n\n");
    return { output: out, title: `${input.questions.length} question(s)`, metadata: { answers } };
  },
});

// ---------- helpers ----------
function formatAnswer(answer: string[] | undefined): string {
  return (answer ?? []).join(", ") || "(no answer)";
}
