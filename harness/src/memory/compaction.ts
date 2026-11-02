// Compaction — Phase 4: when >80% context, summarize old turns, keep key points.
// Stub: reports whether compaction would trigger.
import config from "../../agent.config.json";

export class Compactor {
  constructor(private readonly threshold: number = (config as { compactionThreshold?: number }).compactionThreshold ?? 0.8) {}

  shouldCompact(usedTokens: number, maxTokens: number): boolean {
    return usedTokens / maxTokens >= this.threshold;
  }

  async compact(turns: unknown[]): Promise<string> {
    return `compacted ${Array.isArray(turns) ? turns.length : 0} turns (stub — LLM summarize in Phase 4)`;
  }
}

export const defaultCompactor = new Compactor();

export function shouldCompact(usedTokens: number, maxTokens: number): boolean {
  return defaultCompactor.shouldCompact(usedTokens, maxTokens);
}

export async function compact(turns: unknown[]): Promise<string> {
  return defaultCompactor.compact(turns);
}
