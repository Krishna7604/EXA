// Route table: the current user, personal API tokens and org members.
import type { AccountController } from "../controllers/account.controller.ts";
import type { RouteDef } from "../models/http-context.model.ts";

// ---------- routes ----------
export function accountRoutes(c: AccountController): RouteDef[] {
  return [
    { method: "GET", path: "/v1/me", handler: c.me },
    { method: "POST", path: "/v1/tokens", handler: c.createToken },
    { method: "GET", path: "/v1/tokens", handler: c.listTokens },
    { method: "DELETE", path: "/v1/tokens/:id", handler: c.revokeToken },
    { method: "GET", path: "/v1/members", handler: c.listMembers },
    { method: "POST", path: "/v1/members", handler: c.addMember },
  ];
}
