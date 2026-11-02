// Principal resolution: short-lived HS256 web tokens for browser sessions and long-lived
// hashed API tokens for CLIs/devices. Membership is re-checked on every request.
import { ERROR_CODES } from "../constants/errors.constants.ts";
import type { Jwt } from "../helpers/jwt.helper.ts";
import { HttpError } from "../models/http-error.model.ts";
import type { Role } from "../models/identity.model.ts";
import type { Principal } from "../models/principal.model.ts";
import type { IdentityRepo } from "../repositories/identity.repository.ts";

// ---------- constants ----------
const WEB_TOKEN_TTL_SEC = 12 * 3600;

// ---------- principal service ----------
export class PrincipalService {
  constructor(
    private readonly jwt: Jwt,
    private readonly identity: IdentityRepo,
  ) {}

  async issueWebToken(
    p: { tenantId: string; userId: string; role: Role },
    ttlSec = WEB_TOKEN_TTL_SEC,
  ): Promise<string> {
    return this.jwt.sign({ sub: p.userId, tid: p.tenantId, role: p.role, typ: "web" }, ttlSec);
  }

  /** Principal for a device/CLI API token; 401 when unknown, revoked or expired. */
  async fromApiToken(token: string): Promise<Principal> {
    const apiToken = await this.identity.verifyApiToken(token);
    if (!apiToken) throw new HttpError(401, "invalid or revoked token", ERROR_CODES.unauthorized);
    const role = await this.currentRole(apiToken.tenantId, apiToken.userId);
    return {
      tenantId: apiToken.tenantId,
      userId: apiToken.userId,
      role,
      kind: "token",
      tokenId: apiToken.id,
    };
  }

  /** Principal for a browser-session JWT; 401 when invalid or expired. */
  async fromWebToken(token: string): Promise<Principal> {
    const claims = await this.jwt.verify(token);
    if (claims?.typ !== "web")
      throw new HttpError(401, "invalid or expired session", ERROR_CODES.unauthorized);
    const role = await this.currentRole(claims.tid, claims.sub);
    return { tenantId: claims.tid, userId: claims.sub, role, kind: "web" };
  }

  /** Membership is re-checked on every request so removals take effect immediately. */
  private async currentRole(tenantId: string, userId: string): Promise<Role> {
    const membership = await this.identity.membership(tenantId, userId);
    if (!membership)
      throw new HttpError(403, "no longer a member of this organization", ERROR_CODES.forbidden);
    return membership.role;
  }
}
