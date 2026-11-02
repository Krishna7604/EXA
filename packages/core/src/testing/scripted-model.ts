// Deterministic ModelPort for tests and offline demos.

import type { ModelChunk, ModelRequest } from "@exa/protocol";
import type { ModelPort } from "../models/ports.model.ts";

// ---------- constants ----------
/** Played once the scripted turns run out. */
const DEFAULT_FALLBACK: ModelChunk[] = [
  { type: "text-delta", text: "ok" },
  { type: "finish", reason: "stop", usage: { input: 10, output: 1 } },
];

// ---------- types ----------
export type Script =
  | ModelChunk[]
  | ((req: ModelRequest, call: number) => ModelChunk[] | Promise<ModelChunk[]>);

// ---------- scripted model ----------
export class ScriptedModel implements ModelPort {
  readonly requests: ModelRequest[] = [];
  private call = 0;

  constructor(
    private readonly scripts: Script[],
    private readonly fallback: Script = DEFAULT_FALLBACK,
  ) {}

  async *stream(req: ModelRequest, signal: AbortSignal): AsyncIterable<ModelChunk> {
    this.requests.push(structuredClone(req));
    const n = this.call++;
    const s = this.scripts[n] ?? this.fallback;
    const chunks = typeof s === "function" ? await s(req, n) : s;
    for (const c of chunks) {
      if (signal.aborted) return;
      await Promise.resolve();
      yield c;
    }
  }
}

// ---------- script builders ----------
export const text = (t: string, usage = { input: 100, output: 10 }): ModelChunk[] => [
  { type: "text-delta", text: t },
  { type: "finish", reason: "stop", usage },
];

export const toolCall = (
  name: string,
  input: unknown,
  callId = `call_${Math.random().toString(36).slice(2, 10)}`,
): ModelChunk[] => [
  { type: "tool-call", callId, name, input },
  { type: "finish", reason: "tool-calls", usage: { input: 100, output: 10 } },
];
