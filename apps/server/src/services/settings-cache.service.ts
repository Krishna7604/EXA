// Resolved-settings lookup with a short TTL, so hot paths don't re-run the settings merge
// query on every request. Invalidated per tenant whenever settings or rules change.

import { TtlCache } from "../helpers/ttl-cache.helper.ts";
import type { ResolvedSettings } from "../models/settings.model.ts";
import type { Subject } from "../models/subject.model.ts";
import type { ConfigRepo } from "../repositories/config.repository.ts";

// ---------- constants ----------
const SETTINGS_TTL_MS = 15_000;

// ---------- settings cache ----------
export class SettingsCache {
  private readonly cache = new TtlCache<ResolvedSettings>(SETTINGS_TTL_MS);

  constructor(private readonly config: ConfigRepo) {}

  async resolve(subject: Subject): Promise<ResolvedSettings> {
    const key = `${subject.tenantId}:${subject.userId}:${subject.projectId ?? ""}`;
    const cached = this.cache.get(key);
    if (cached) return cached;
    const settings = await this.config.resolveSettings(subject);
    this.cache.set(key, settings);
    return settings;
  }

  invalidate(tenantId: string): void {
    this.cache.deletePrefix(`${tenantId}:`);
  }
}
