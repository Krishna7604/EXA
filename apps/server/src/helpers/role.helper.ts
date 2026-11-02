// Role checks on an authenticated principal: who counts as an admin, and the 401/403 guards
// controllers use before calling a service.
import { ERROR_CODES } from "../constants/errors.constants.ts";
import { HttpError } from "../models/http-error.model.ts";
import type { Role } from "../models/identity.model.ts";
import type { Principal } from "../models/principal.model.ts";

// ---------- roles ----------
export function requireRole(p: Principal | undefined, ...roles: Role[]): Principal {
  if (!p) throw new HttpError(401, "unauthorized", ERROR_CODES.unauthorized);
  if (!roles.includes(p.role))
    throw new HttpError(403, `requires role: ${roles.join(" or ")}`, ERROR_CODES.forbidden);
  return p;
}

export const isAdmin = (p: Principal): boolean => p.role === "owner" || p.role === "admin";

/** Gate for admin-only endpoints (403 "admins only"). */
export function requireAdmin(p: Principal): void {
  if (!isAdmin(p)) throw new HttpError(403, "admins only", ERROR_CODES.forbidden);
}
