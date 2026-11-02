// Token-usage arithmetic: an empty counter and adding partial usage onto a running total.

import type { Tokens } from "../models/messages.model.ts";

// ---------- tokens ----------
export const zeroTokens = (): Tokens => ({
  input: 0,
  output: 0,
  reasoning: 0,
  cacheRead: 0,
  cacheWrite: 0,
});

export function addTokens(a: Tokens, b: Partial<Tokens>): Tokens {
  return {
    input: a.input + (b.input ?? 0),
    output: a.output + (b.output ?? 0),
    reasoning: a.reasoning + (b.reasoning ?? 0),
    cacheRead: a.cacheRead + (b.cacheRead ?? 0),
    cacheWrite: a.cacheWrite + (b.cacheWrite ?? 0),
  };
}
