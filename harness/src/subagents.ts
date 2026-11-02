// Sub-agents — Phase 4: researcher (Python RAG) + coder (TS) in parallel, main merges.
// Types live in ./types.ts.
import type { SubAgentResult } from "./types.js";

export class SubAgentManager {
  async spawn(task: string, correlationId: string): Promise<SubAgentResult> {
    // TODO Phase 4: real parallel delegation with structured merge.
    return { task, correlationId, status: "stubbed", result: null };
  }
}

export const defaultSubAgents = new SubAgentManager();

export async function spawnSubAgent(task: string, correlationId: string): Promise<SubAgentResult> {
  return defaultSubAgents.spawn(task, correlationId);
}
