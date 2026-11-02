// Sign-in flows: dev login, OIDC ID-token exchange, and the device-code flow the CLI uses
// (start → user approves in the browser → CLI polls for an API token).

import type { api } from "@exa/protocol";
import type { z } from "zod";
import type { ServerConfig } from "../config/env.config.ts";
import { ERROR_CODES } from "../constants/errors.constants.ts";
import { HttpError } from "../models/http-error.model.ts";
import type { Role } from "../models/identity.model.ts";
import type { Principal } from "../models/principal.model.ts";
import type { ServiceDeps } from "./service-deps.ts";

// ---------- constants ----------
/** Seconds the CLI should wait between device-code polls. */
const DEVICE_POLL_INTERVAL_SEC = 2;
const DEVICE_TOKEN_TTL_DAYS = 90;
const DEVICE_TOKEN_NAME = "device login";

// ---------- types ----------
type DevLoginInput = z.infer<typeof api.DevLoginBody>;
type OidcLoginInput = z.infer<typeof api.OidcLoginBody>;
type DeviceStartInput = z.infer<typeof api.DeviceStartBody>;
type DevicePollInput = z.infer<typeof api.DevicePollBody>;
type DeviceApproveInput = z.infer<typeof api.DeviceApproveBody>;
type OidcConfig = NonNullable<ServerConfig["oidc"]>;

interface TenantRef {
  id: string;
  slug: string;
}

interface UserRef {
  id: string;
  email: string;
}

export interface LoginResult {
  token: string;
  tenant: TenantRef;
  user: UserRef;
  role: Role;
}

// ---------- auth service ----------
export class AuthService {
  constructor(private readonly deps: ServiceDeps) {}

  /** What the sign-in page should offer. */
  authConfig(): { devAuth: boolean; oidc: { issuer: string } | null } {
    const oidc = this.deps.cfg.oidc;
    return { devAuth: this.deps.cfg.devAuth, oidc: oidc ? { issuer: oidc.issuer } : null };
  }

  /** Dev login is invisible (404) unless EXA_DEV_AUTH=1. */
  assertDevLoginEnabled(): void {
    if (!this.deps.cfg.devAuth) throw new HttpError(404, "not found", ERROR_CODES.notFound);
  }

  /** Creates the tenant (caller becomes owner) and user on first use. */
  async devLogin(input: DevLoginInput): Promise<LoginResult> {
    const identity = this.deps.identity;
    let tenant = await identity.tenantBySlug(input.tenant);
    const user = await identity.upsertUser(input.email, input.name);
    if (!tenant) {
      tenant = await identity.createTenant(input.tenant);
      await identity.addMember(tenant.id, user.id, "owner");
    } else if (!(await identity.membership(tenant.id, user.id))) {
      await identity.addMember(tenant.id, user.id, "member");
    }
    const membership = (await identity.membership(tenant.id, user.id))!;
    return this.issueLogin(tenant, user, membership.role, "dev");
  }

  assertOidcEnabled(): void {
    if (!this.deps.oidc || !this.deps.cfg.oidc)
      throw new HttpError(404, "OIDC is not configured", ERROR_CODES.notFound);
  }

  /** Exchange a verified ID token from the org's IdP for an exa session. */
  async oidcLogin(input: OidcLoginInput): Promise<LoginResult> {
    this.assertOidcEnabled();
    const oidcConfig = this.deps.cfg.oidc!;
    const id = await this.deps.oidc!.verify(input.idToken);
    const identity = this.deps.identity;
    const user =
      (await identity.userBySubject(id.sub)) ??
      (await identity.upsertUser(id.email, id.name, id.sub));
    const slug = oidcTenantSlug(id.claims, input.tenant, oidcConfig);
    if (!slug) {
      throw new HttpError(
        400,
        "no tenant: pass `tenant` or configure EXA_OIDC_DEFAULT_TENANT",
        ERROR_CODES.noTenant,
      );
    }
    const tenant = await this.oidcTenant(slug, user.id, oidcConfig);
    const role = await this.oidcRole(tenant.id, user.id, oidcConfig);
    return this.issueLogin(tenant, user, role, "oidc");
  }

  async startDevice(input: DeviceStartInput) {
    const code = await this.deps.identity.createDeviceCode(input.clientName);
    const verificationUri = `${this.deps.cfg.publicUrl}/#/device`;
    return {
      deviceCode: code.deviceCode,
      userCode: code.userCode,
      verificationUri,
      verificationUriComplete: `${verificationUri}?code=${encodeURIComponent(code.userCode)}`,
      expiresIn: code.expiresIn,
      interval: DEVICE_POLL_INTERVAL_SEC,
    };
  }

  /** Errors use the OAuth device-flow codes the CLI polls for (all HTTP 400). */
  async pollDevice(input: DevicePollInput) {
    const identity = this.deps.identity;
    const poll = await identity.pollDeviceCode(input.deviceCode);
    if (poll.status === "pending")
      throw new HttpError(400, "waiting for approval", ERROR_CODES.authorizationPending);
    if (poll.status !== "approved") {
      const code = poll.status === "denied" ? ERROR_CODES.accessDenied : ERROR_CODES.expiredToken;
      throw new HttpError(400, poll.status, code);
    }
    const apiToken = await identity.createApiToken({
      tenantId: poll.tenantId,
      userId: poll.userId,
      name: DEVICE_TOKEN_NAME,
      deviceName: poll.clientName,
      ttlDays: DEVICE_TOKEN_TTL_DAYS,
    });
    const tenant = (await identity.tenant(poll.tenantId))!;
    const user = (await identity.user(poll.userId))!;
    this.deps.telemetry.recordAudit({
      tenantId: poll.tenantId,
      actorUserId: poll.userId,
      action: "token.created",
      target: poll.clientName,
    });
    return {
      token: apiToken.token,
      tokenId: apiToken.id,
      tenant: { id: tenant.id, slug: tenant.slug },
      user: { id: user.id, email: user.email },
    };
  }

  async approveDevice(p: Principal, input: DeviceApproveInput): Promise<void> {
    const ok = await this.deps.identity.approveDeviceCode(input.userCode, p.tenantId, p.userId);
    if (!ok) throw new HttpError(404, "code not found or expired", ERROR_CODES.notFound);
  }

  /** Unknown orgs are only auto-created when the IdP asserts the tenant via a claim. */
  private async oidcTenant(slug: string, userId: string, oidcConfig: OidcConfig) {
    const existing = await this.deps.identity.tenantBySlug(slug);
    if (existing) return existing;
    if (!oidcConfig.tenantClaim)
      throw new HttpError(403, "unknown organization", ERROR_CODES.forbidden);
    const tenant = await this.deps.identity.createTenant(slug);
    await this.deps.identity.addMember(tenant.id, userId, "owner");
    return tenant;
  }

  /** With a tenant claim the IdP is authoritative, so missing members are added. */
  private async oidcRole(tenantId: string, userId: string, oidcConfig: OidcConfig): Promise<Role> {
    const identity = this.deps.identity;
    let membership = await identity.membership(tenantId, userId);
    if (!membership && oidcConfig.tenantClaim) {
      await identity.addMember(tenantId, userId, "member");
      membership = await identity.membership(tenantId, userId);
    }
    if (!membership)
      throw new HttpError(403, "you are not a member of this organization", ERROR_CODES.forbidden);
    return membership.role;
  }

  private async issueLogin(
    tenant: TenantRef,
    user: UserRef,
    role: Role,
    method: "dev" | "oidc",
  ): Promise<LoginResult> {
    const token = await this.deps.principals.issueWebToken({
      tenantId: tenant.id,
      userId: user.id,
      role,
    });
    this.deps.telemetry.recordAudit({
      tenantId: tenant.id,
      actorUserId: user.id,
      action: "login",
      target: method,
    });
    return {
      token,
      tenant: { id: tenant.id, slug: tenant.slug },
      user: { id: user.id, email: user.email },
      role,
    };
  }
}

// ---------- helpers ----------
/** The IdP's tenant claim wins, then the tenant the client asked for, then the configured default. */
function oidcTenantSlug(
  claims: Record<string, unknown>,
  requested: string | undefined,
  oidcConfig: OidcConfig,
): string | undefined {
  const claimed = oidcConfig.tenantClaim ? claims[oidcConfig.tenantClaim] : undefined;
  if (typeof claimed === "string" && claimed) return claimed;
  return requested || oidcConfig.defaultTenant;
}
