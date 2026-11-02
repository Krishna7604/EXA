// Route table: org/user skills and agents.
import type { ExtensionController } from "../controllers/extension.controller.ts";
import type { RouteDef } from "../models/http-context.model.ts";

// ---------- routes ----------
export function extensionRoutes(c: ExtensionController): RouteDef[] {
  return [
    { method: "GET", path: "/v1/skills", handler: c.listSkills },
    { method: "PUT", path: "/v1/skills", handler: c.putSkill },
    { method: "DELETE", path: "/v1/skills/:name", handler: c.deleteSkill },
    { method: "GET", path: "/v1/agents", handler: c.listAgents },
    { method: "PUT", path: "/v1/agents", handler: c.putAgent },
    { method: "DELETE", path: "/v1/agents/:name", handler: c.deleteAgent },
  ];
}
