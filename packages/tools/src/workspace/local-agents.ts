// Custom agent definitions from markdown files in the project's and user's config dirs.

import { homedir } from "node:os";
import { join } from "node:path";
import type { AgentDef } from "@exa/core";
import { CONFIG_DIRS, readMarkdownDefinitions } from "./config-markdown.ts";

// ---------- local agents ----------
/** Custom agents: <root>/{.exa,.opencode,.claude}/agents/*.md then ~/.exa/agents/*.md. */
export async function loadLocalAgents(
  root: string,
  home: string = homedir(),
): Promise<Array<AgentDef>> {
  const { parseAgentMarkdown } = await import("@exa/core");
  const files = await readMarkdownDefinitions([
    ...CONFIG_DIRS.map((d) => join(root, d, "agents")),
    join(home, ".exa", "agents"),
  ]);
  const out: AgentDef[] = [];
  for (const f of files) {
    try {
      out.push(parseAgentMarkdown(f.name, f.text));
    } catch {
      // invalid definition (e.g. no description) is skipped
    }
  }
  return out;
}
