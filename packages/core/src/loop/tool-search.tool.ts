// The `tool_search` tool: loads schemas of deferred (MCP) tools on demand to keep every
// request small.

import { z } from "zod";
import { defineTool } from "../helpers/tool.helper.ts";
import type { ToolSpec } from "../models/tool.model.ts";
import type { AgentLoop } from "./agent-loop.ts";

// ---------- constants ----------
const DESCRIPTION =
  'Load deferred tools so you can call them. Use "select:name1,name2" for exact names, or keywords to search names and descriptions. Returns the matching tools; they are callable from the next step.';
const SELECT_PREFIX = "select:";
const DEFAULT_MAX_RESULTS = 10;
const MAX_RESULTS_LIMIT = 30;
const NAME_MATCH_SCORE = 2;
const DESCRIPTION_MATCH_SCORE = 1;

// ---------- tool search tool ----------
/** tool_search: load schemas of deferred (MCP) tools on demand to keep every request small. */
export function createToolSearchTool(loop: AgentLoop): ToolSpec {
  return defineTool({
    name: "tool_search",
    description: DESCRIPTION,
    schema: z.object({
      query: z.string().min(1).describe('"select:a,b" or keywords'),
      max_results: z.number().int().min(1).max(MAX_RESULTS_LIMIT).optional(),
    }),
    readonly: true,
    permissions: () => [],
    async execute(input, ctx) {
      const deferred = loop.deferred.get(ctx.sessionId);
      if (!deferred?.all.length) {
        return {
          output: "No deferred tools in this session — all tools are already loaded.",
          title: "no deferred tools",
        };
      }
      const matches = input.query.startsWith(SELECT_PREFIX)
        ? selectByName(deferred.all, input.query.slice(SELECT_PREFIX.length))
        : searchByKeywords(deferred.all, input.query);
      const hits = matches.slice(0, input.max_results ?? DEFAULT_MAX_RESULTS);
      for (const h of hits) deferred.loaded.add(h.name);
      if (!hits.length)
        return { output: `No deferred tool matches "${input.query}".`, title: "0 tools" };
      const list = hits.map((h) => `- ${h.name}: ${h.description}`).join("\n");
      return {
        output: `Loaded ${hits.length} tool(s); call them directly now:\n${list}`,
        title: `${hits.length} tool(s) loaded`,
        metadata: { tools: hits.map((h) => h.name) },
      };
    },
  });
}

// ---------- helpers ----------
function selectByName(tools: ToolSpec[], names: string): ToolSpec[] {
  const wanted = new Set(
    names
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean),
  );
  return tools.filter((t) => wanted.has(t.name));
}

/** Tools ranked by keyword hits (name matches weigh more than description matches). */
function searchByKeywords(tools: ToolSpec[], query: string): ToolSpec[] {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  return tools
    .map((tool) => ({ tool, score: keywordScore(tool, terms) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((x) => x.tool);
}

function keywordScore(tool: ToolSpec, terms: string[]): number {
  const name = tool.name.toLowerCase();
  const description = tool.description.toLowerCase();
  let score = 0;
  for (const term of terms) {
    if (name.includes(term)) score += NAME_MATCH_SCORE;
    if (description.includes(term)) score += DESCRIPTION_MATCH_SCORE;
  }
  return score;
}
