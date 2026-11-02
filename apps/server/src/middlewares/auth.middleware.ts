// Authentication middleware: reads the Bearer token from the Authorization header and
// resolves it to a Principal (API tokens start with "exa_", anything else is a web JWT).
import { ERROR_CODES } from "../constants/errors.constants.ts";
import { HttpError } from "../models/http-error.model.ts";
import type { Principal } from "../models/principal.model.ts";
import type { PrincipalService } from "../services/principal.service.ts";

// ---------- constants ----------
const API_TOKEN_PREFIX = "exa_";
const BEARER = /^Bearer\s+(.+)$/i;

// ---------- auth middleware ----------
export class AuthMiddleware {
  constructor(private readonly principals: PrincipalService) {}

  /** Resolve the Authorization header; throws 401 on anything invalid. */
  async authenticate(req: Request): Promise<Principal> {
    const header = req.headers.get("authorization") ?? "";
    const m = header.match(BEARER);
    if (!m) throw new HttpError(401, "missing bearer token", ERROR_CODES.unauthorized);
    const token = m[1].trim();
    if (token.startsWith(API_TOKEN_PREFIX)) return this.principals.fromApiToken(token);
    return this.principals.fromWebToken(token);
  }
}
