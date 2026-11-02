// Agent definition row (org/user-scoped agents shared to every client). The server stores
// these; the CLI reads them back from the API with this same shape.

// ---------- types ----------
export interface AgentRow {
  id: string;
  scope: "tenant" | "user";
  name: string;
  description: string;
  mode: "primary" | "subagent" | "all";
  hidden: boolean;
  prompt: string;
  permission: Record<string, "allow" | "ask" | "deny"> | null;
  model: string | null;
  tier: string | null;
  temperature: number | null;
  steps: number | null;
}
