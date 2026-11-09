// Web search for the heavy client's `websearch` tool, configured from the environment:
// TAVILY_API_KEY, BRAVE_SEARCH_API_KEY, EXA_SEARXNG_URL, or EXA_SEARCH_PROVIDER to force one
// ("off" disables it). With none set, the keyless DuckDuckGo fallback is used.

import type { SearchPort } from "@exa/core";
import { createSearchPort, type SearchProviderConfig } from "@exa/tools";

// ---------- types ----------
type Env = Record<string, string | undefined>;

// ---------- config ----------
/** The search port, or null with the reason when it is off or misconfigured. */
export function searchFromEnv(env: Env): { search: SearchPort | null; error?: string } {
  try {
    return { search: createSearchPort(searchConfigFrom(env)) };
  } catch (err) {
    return { search: null, error: (err as Error).message };
  }
}

export function searchConfigFrom(env: Env): SearchProviderConfig {
  return {
    provider: env.EXA_SEARCH_PROVIDER || undefined,
    tavilyKey: env.TAVILY_API_KEY || undefined,
    braveKey: env.BRAVE_SEARCH_API_KEY || undefined,
    searxngUrl: env.EXA_SEARXNG_URL || undefined,
  };
}
