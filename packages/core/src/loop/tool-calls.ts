// Runs all tool calls of one step: consecutive read-only calls run in parallel, anything else
// runs alone, and a user rejection (or abort) skips everything after it.

import type { ToolPart } from "@exa/protocol";
import { ABORTED_MESSAGE, failToolPart } from "./parts.ts";
import type { LoopRuntime } from "./runtime.ts";
import { executeToolCall, type ToolCallContext, type ToolCallOutcome } from "./tool-call.ts";

// ---------- constants ----------
const SKIPPED_AFTER_REJECTION = "Skipped: an earlier tool call was rejected.";

// ---------- tool calls ----------
export async function runToolCalls(
  rt: LoopRuntime,
  calls: ToolPart[],
  ctx: ToolCallContext,
): Promise<ToolCallOutcome> {
  const total: ToolCallOutcome = { rejected: false, mutated: false };
  for (const batch of groupIntoBatches(rt, calls)) {
    if (total.rejected || ctx.signal.aborted) {
      const reason = ctx.signal.aborted ? ABORTED_MESSAGE : SKIPPED_AFTER_REJECTION;
      for (const call of batch) failToolPart(call, reason);
      continue;
    }
    const results = await Promise.all(batch.map((call) => executeToolCall(rt, call, ctx)));
    for (const r of results) {
      if (r.rejected) total.rejected = true;
      if (r.mutated) total.mutated = true;
    }
  }
  for (const call of calls) rt.emit("message.part.updated", ctx.session.id, { part: call });
  return total;
}

/** Calls that will never run (the stream failed or was aborted) get a final error state. */
export function failToolCalls(calls: ToolPart[], reason: string): void {
  for (const call of calls) failToolPart(call, reason);
}

// ---------- helpers ----------
function groupIntoBatches(rt: LoopRuntime, calls: ToolPart[]): ToolPart[][] {
  const isReadonly = (call: ToolPart) => !!rt.deps.tools.get(call.tool)?.readonly;
  const batches: ToolPart[][] = [];
  for (const call of calls) {
    const last = batches[batches.length - 1];
    if (isReadonly(call) && last?.every(isReadonly)) last.push(call);
    else batches.push([call]);
  }
  return batches;
}
