// Route table: settings, permission rules and quotas.
import type { SettingsController } from "../controllers/settings.controller.ts";
import type { RouteDef } from "../models/http-context.model.ts";

// ---------- routes ----------
export function settingsRoutes(c: SettingsController): RouteDef[] {
  return [
    { method: "GET", path: "/v1/settings", handler: c.resolved },
    { method: "PUT", path: "/v1/settings", handler: c.put },
    { method: "GET", path: "/v1/rules", handler: c.listRules },
    { method: "POST", path: "/v1/rules", handler: c.addRule },
    { method: "DELETE", path: "/v1/rules/:id", handler: c.deleteRule },
    { method: "PUT", path: "/v1/quotas", handler: c.setQuota },
  ];
}
