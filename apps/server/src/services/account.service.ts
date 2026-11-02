// The signed-in user's account: profile + effective settings, personal API tokens, and the
// organization's member list.

import type { api } from "@exa/protocol";
import type { z } from "zod";
import { ERROR_CODES } from "../constants/errors.constants.ts";
import { HttpError } from "../models/http-error.model.ts";
import type { Principal } from "../models/principal.model.ts";
import type { ServiceDeps } from "./service-deps.ts";

// ---------- types ----------
type CreateApiTokenInput = z.infer<typeof api.CreateApiTokenBody>;
type AddMemberInput = z.infer<typeof api.AddMemberBody>;

// ---------- account service ----------
export class AccountService {
  constructor(private readonly deps: ServiceDeps) {}

  async me(p: Principal) {
    const identity = this.deps.identity;
    const [user, tenant, tenants, settings] = await Promise.all([
      identity.user(p.userId),
      identity.tenant(p.tenantId),
      identity.tenantsForUser(p.userId),
      this.deps.settings(p),
    ]);
    return {
      user,
      tenant,
      role: p.role,
      tenants: tenants.map((t) => ({ id: t.id, slug: t.slug, role: t.role })),
      settings: settings.values,
      locked: [...settings.locked],
      byokAvailable: !!this.deps.vault,
    };
  }

  async createToken(
    p: Principal,
    input: CreateApiTokenInput,
  ): Promise<{ id: string; token: string }> {
    const apiToken = await this.deps.identity.createApiToken({
      tenantId: p.tenantId,
      userId: p.userId,
      name: input.name,
      scopes: input.scopes,
      ttlDays: input.ttlDays,
    });
    this.deps.telemetry.recordAudit({
      tenantId: p.tenantId,
      actorUserId: p.userId,
      action: "token.created",
      target: input.name,
    });
    return { id: apiToken.id, token: apiToken.token };
  }

  listTokens(p: Principal) {
    return this.deps.identity.listApiTokens(p.tenantId, p.userId);
  }

  async revokeToken(p: Principal, tokenId: string): Promise<void> {
    const revoked = await this.deps.identity.revokeApiToken(p.tenantId, p.userId, tokenId);
    if (!revoked) throw new HttpError(404, "token not found", ERROR_CODES.notFound);
    this.deps.telemetry.recordAudit({
      tenantId: p.tenantId,
      actorUserId: p.userId,
      action: "token.revoked",
      target: tokenId,
    });
  }

  listMembers(p: Principal) {
    return this.deps.identity.members(p.tenantId);
  }

  /** Adds (or creates) a user by email. Only owners may add owners. */
  async addMember(p: Principal, input: AddMemberInput) {
    if (input.role === "owner" && p.role !== "owner")
      throw new HttpError(403, "only owners can add owners", ERROR_CODES.forbidden);
    const user = await this.deps.identity.upsertUser(input.email);
    await this.deps.identity.addMember(p.tenantId, user.id, input.role);
    this.deps.telemetry.recordAudit({
      tenantId: p.tenantId,
      actorUserId: p.userId,
      action: "member.added",
      target: input.email,
      decision: input.role,
    });
    return { userId: user.id, email: user.email, role: input.role };
  }
}
