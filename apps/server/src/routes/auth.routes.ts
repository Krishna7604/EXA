// Route table: sign-in (dev, OIDC) and the CLI device-code flow
// (start → user approves in the browser → CLI polls for a token).
import type { AuthController } from "../controllers/auth.controller.ts";
import type { RouteDef } from "../models/http-context.model.ts";

// ---------- routes ----------
export function authRoutes(c: AuthController): RouteDef[] {
  return [
    { method: "GET", path: "/v1/auth/config", handler: c.config, auth: false },
    { method: "POST", path: "/v1/auth/dev-login", handler: c.devLogin, auth: false },
    { method: "POST", path: "/v1/auth/oidc", handler: c.oidcLogin, auth: false },
    { method: "POST", path: "/v1/auth/device", handler: c.startDevice, auth: false },
    { method: "POST", path: "/v1/auth/device/token", handler: c.pollDevice, auth: false },
    { method: "POST", path: "/v1/auth/device/approve", handler: c.approveDevice },
  ];
}
