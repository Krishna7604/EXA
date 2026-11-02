// Agent registry: the agents available to a loop, looked up by name and mode.

import type { AgentDef } from "../models/agent.model.ts";
import { BUILTIN_AGENTS } from "./builtin-agents.ts";

// ---------- agent registry ----------
export class AgentRegistry {
  private readonly agents = new Map<string, AgentDef>();

  constructor(defs: AgentDef[] = BUILTIN_AGENTS) {
    for (const d of defs) this.agents.set(d.name, d);
  }

  register(def: AgentDef): void {
    this.agents.set(def.name, def);
  }

  get(name: string): AgentDef | undefined {
    return this.agents.get(name);
  }

  require(name: string): AgentDef {
    const agent = this.agents.get(name);
    if (agent) return agent;
    const available = this.list()
      .map((a) => a.name)
      .join(", ");
    throw new Error(`unknown agent "${name}". Available: ${available}`);
  }

  list(): AgentDef[] {
    return [...this.agents.values()];
  }

  subagents(): AgentDef[] {
    return this.list().filter((a) => (a.mode === "subagent" || a.mode === "all") && !a.hidden);
  }

  primaries(): AgentDef[] {
    return this.list().filter((a) => (a.mode === "primary" || a.mode === "all") && !a.hidden);
  }
}
