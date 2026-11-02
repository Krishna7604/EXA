// Identity facade for the auth layer: one entry point over the tenant, user, membership,
// API-token and device-code repos (all global tables, no RLS). Callers keep using IdentityRepo;
// the SQL for each table lives in its own repository file.
import type { Db } from "@exa/store";
import type {
  DevicePollResult,
  Membership,
  NewApiToken,
  NewDeviceCode,
  Role,
  Tenant,
  User,
  VerifiedApiToken,
} from "../models/identity.model.ts";
import { ApiTokenRepo } from "./api-token.repository.ts";
import { DeviceCodeRepo } from "./device-code.repository.ts";
import { MembershipRepo } from "./membership.repository.ts";
import { TenantRepo } from "./tenant.repository.ts";
import { UserRepo } from "./user.repository.ts";

// ---------- identity repo ----------
export class IdentityRepo {
  private readonly tenants: TenantRepo;
  private readonly users: UserRepo;
  private readonly memberships: MembershipRepo;
  private readonly apiTokens: ApiTokenRepo;
  private readonly deviceCodes: DeviceCodeRepo;

  constructor(db: Db) {
    this.tenants = new TenantRepo(db);
    this.users = new UserRepo(db);
    this.memberships = new MembershipRepo(db);
    this.apiTokens = new ApiTokenRepo(db);
    this.deviceCodes = new DeviceCodeRepo(db);
  }

  // ---- tenants ----
  createTenant(slug: string, name = slug): Promise<Tenant> {
    return this.tenants.create(slug, name);
  }

  tenantBySlug(slug: string): Promise<Tenant | null> {
    return this.tenants.bySlug(slug);
  }

  tenant(id: string): Promise<Tenant | null> {
    return this.tenants.byId(id);
  }

  allTenants(): Promise<Tenant[]> {
    return this.tenants.allActive();
  }

  bumpPolicyVersion(tenantId: string): Promise<number> {
    return this.tenants.bumpPolicyVersion(tenantId);
  }

  // ---- users ----
  upsertUser(email: string, displayName?: string, authSubject?: string): Promise<User> {
    return this.users.upsert(email, displayName, authSubject);
  }

  user(id: string): Promise<User | null> {
    return this.users.byId(id);
  }

  userBySubject(sub: string): Promise<User | null> {
    return this.users.bySubject(sub);
  }

  // ---- memberships ----
  addMember(tenantId: string, userId: string, role: Role): Promise<void> {
    return this.memberships.add(tenantId, userId, role);
  }

  membership(tenantId: string, userId: string): Promise<Membership | null> {
    return this.memberships.active(tenantId, userId);
  }

  members(tenantId: string): Promise<Array<Membership & { email: string }>> {
    return this.memberships.ofTenant(tenantId);
  }

  tenantsForUser(userId: string): Promise<Array<Tenant & { role: Role }>> {
    return this.memberships.tenantsOfUser(userId);
  }

  // ---- API tokens (stored hashed; shown once) ----
  createApiToken(opts: NewApiToken): Promise<{ id: string; token: string }> {
    return this.apiTokens.create(opts);
  }

  verifyApiToken(token: string): Promise<VerifiedApiToken | null> {
    return this.apiTokens.verify(token);
  }

  revokeApiToken(tenantId: string, userId: string, id: string): Promise<boolean> {
    return this.apiTokens.revoke(tenantId, userId, id);
  }

  listApiTokens(tenantId: string, userId: string) {
    return this.apiTokens.list(tenantId, userId);
  }

  // ---- device authorization (CLI login) ----
  createDeviceCode(clientName: string): Promise<NewDeviceCode> {
    return this.deviceCodes.create(clientName);
  }

  approveDeviceCode(userCode: string, tenantId: string, userId: string): Promise<boolean> {
    return this.deviceCodes.approve(userCode, tenantId, userId);
  }

  /** Returns the approval once (then marks it consumed); "pending" / "expired" / "denied" otherwise. */
  pollDeviceCode(deviceCode: string): Promise<DevicePollResult> {
    return this.deviceCodes.poll(deviceCode);
  }

  purgeExpiredDeviceCodes(): Promise<number> {
    return this.deviceCodes.purgeExpired();
  }
}
