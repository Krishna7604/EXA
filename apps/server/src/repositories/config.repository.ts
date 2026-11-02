// Tenant config facade: one entry point over the settings, permission-rule, BYOK-key and quota
// repos (all tenant-scoped, RLS). Callers keep using ConfigRepo; each concern lives in its own file.
import type { PermissionRule } from "@exa/protocol";
import type { Db } from "@exa/store";
import type { NewRule } from "../models/permission-rule.model.ts";
import type {
  NewProviderKey,
  ProviderKeySummary,
  StoredProviderKey,
} from "../models/provider-key.model.ts";
import type { QuotaLimits } from "../models/quota.model.ts";
import type { ResolvedSettings } from "../models/settings.model.ts";
import type { SettingScope, Subject } from "../models/subject.model.ts";
import { PermissionRulesRepo } from "./permission-rules.repository.ts";
import { ProviderKeysRepo } from "./provider-keys.repository.ts";
import { QuotasRepo } from "./quotas.repository.ts";
import { SettingsRepo } from "./settings.repository.ts";

// ---------- config repo ----------
export class ConfigRepo {
  private readonly settings: SettingsRepo;
  private readonly permissionRules: PermissionRulesRepo;
  private readonly keys: ProviderKeysRepo;
  private readonly quotas: QuotasRepo;

  constructor(db: Db) {
    this.settings = new SettingsRepo(db);
    this.permissionRules = new PermissionRulesRepo(db);
    this.keys = new ProviderKeysRepo(db);
    this.quotas = new QuotasRepo(db);
  }

  // ---- settings ----
  async resolveSettings(s: Subject): Promise<ResolvedSettings> {
    return this.settings.resolve(s);
  }

  /** Throws if a higher scope locked the key. */
  async putSetting(
    s: Subject,
    scope: SettingScope,
    scopeId: string,
    key: string,
    value: unknown,
    locked = false,
    by?: string,
  ): Promise<void> {
    await this.settings.put(s, { scope, scopeId, key, value }, { locked, by });
  }

  async deleteSetting(
    s: Subject,
    scope: SettingScope,
    scopeId: string,
    key: string,
  ): Promise<void> {
    await this.settings.delete(s, { scope, scopeId, key });
  }

  // ---- permission rules ----
  /** Rules in precedence order: tenant < project < user (then priority, then age). */
  async rules(s: Subject): Promise<PermissionRule[]> {
    return this.permissionRules.list(s);
  }

  async addRule(s: Subject, r: NewRule, by?: string): Promise<string> {
    return this.permissionRules.add(s, r, by);
  }

  async deleteRule(s: Subject, id: string, allowedScopes: SettingScope[]): Promise<boolean> {
    return this.permissionRules.delete(s, id, allowedScopes);
  }

  // ---- BYOK keys (ciphertext only) ----
  async putKey(s: Subject, k: NewProviderKey): Promise<string> {
    return this.keys.put(s, k);
  }

  /** User key first, then tenant key. */
  async findKey(s: Subject, provider: string): Promise<StoredProviderKey | null> {
    return this.keys.find(s, provider);
  }

  async listKeys(s: Subject): Promise<ProviderKeySummary[]> {
    return this.keys.list(s);
  }

  async revokeKey(s: Subject, id: string, allowTenant: boolean): Promise<boolean> {
    return this.keys.revoke(s, id, allowTenant);
  }

  async touchKey(tenantId: string, id: string): Promise<void> {
    await this.keys.touch(tenantId, id);
  }

  // ---- quotas ----
  async setQuota(tenantId: string, q: QuotaLimits): Promise<void> {
    await this.quotas.set(tenantId, q);
  }

  /** Null when within quota, else a human message. */
  async quotaExceeded(tenantId: string, userId: string): Promise<string | null> {
    return this.quotas.exceeded(tenantId, userId);
  }
}
