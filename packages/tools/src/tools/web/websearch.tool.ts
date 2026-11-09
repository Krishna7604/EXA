// websearch: search the web through the host's SearchPort (`services.search`: Tavily, Brave,
// SearXNG, …) and return titles, links and snippets for the agent to read further with webfetch.

import { defineTool, type SearchPort } from "@exa/core";
import { z } from "zod";

// ---------- constants ----------
const DEFAULT_RESULTS = 6;
const MAX_RESULTS = 15;

// ---------- websearch tool ----------
export const websearchTool = defineTool({
  name: "websearch",
  description:
    "Search the web. Returns titles, URLs and short snippets, newest information first when the provider supports it. " +
    "Use it for anything current, factual or outside your knowledge, then read the most relevant pages with webfetch before relying on them. " +
    "Cite the URLs you use.",
  schema: z.object({
    query: z.string().trim().min(1).max(400).describe("Search terms, as you'd type them"),
    limit: z.number().int().min(1).max(MAX_RESULTS).default(DEFAULT_RESULTS),
  }),
  readonly: true,
  permissions: (input) => [{ permission: "websearch", patterns: [input.query] }],
  async execute(input, ctx) {
    const search = ctx.services.search as SearchPort | undefined;
    if (!search) return { title: "search unavailable", output: "Web search is not configured." };
    const results = await search.search(input.query, { limit: input.limit, signal: ctx.signal });
    if (!results.length) return { title: `${input.query} · 0 results`, output: "No results." };
    const lines = results.map((r, i) => {
      const date = r.published ? ` (${r.published.slice(0, 10)})` : "";
      return `${i + 1}. ${r.title}${date}\n   ${r.url}\n   ${r.snippet}`;
    });
    return {
      title: `${input.query} · ${results.length} results`,
      output: lines.join("\n"),
      metadata: { provider: search.provider, results },
    };
  },
});
