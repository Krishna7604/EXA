// Layered settings (tenant < project < user). A tenant can lock a key so lower scopes can't
// override it.
import type { Db } from "@exa/store";
import { NO_PROJECT_ID } from "../constants/ids.constants.ts";
import { SCOPE_PRECEDENCE, SETTING_DEFAULTS } from "../constants/settings.constants.ts";
import type {
  PutSettingOpts,
  ResolvedSettings,
  SettingRow,
  SettingTarget,
} from "../models/settings.model.ts";
import type { SettingScope, Subject } from "../models/subject.model.ts";

// ---------- settings repo ----------
export class SettingsRepo {
  constructor(private readonly db: Db) {}

  async resolve(s: Subject): Promise<ResolvedSettings> {
    const rows = await this.db.withTenant(s.tenantId, (q) =>
      q.query<SettingRow>(
        `select scope, key, value, locked from settings
         where (scope = 'tenant' and scope_id = $1) or (scope = 'user' and scope_id = $2) or (scope = 'project' and scope_id = $3)`,
        [s.tenantId, s.userId, s.projectId ?? NO_PROJECT_ID],
      ),
    );
    return layerSettings(rows);
  }

  /** Throws if a higher scope locked the key. */
  async put(
    s: Subject,
    target: SettingTarget & { value: unknown },
    opts: PutSettingOpts = {},
  ): Promise<void> {
    const { scope, scopeId, key, value } = target;
    if (scope !== "tenant") await this.assertNotLocked(s, target);
    await this.db.withTenant(s.tenantId, (q) =>
      q.query(
        `insert into settings (tenant_id, scope, scope_id, key, value, locked, updated_by) values ($1,$2,$3,$4,($5::text)::jsonb,$6,$7)
         on conflict (tenant_id, scope, scope_id, key) do update set value = excluded.value, locked = excluded.locked,
           updated_by = excluded.updated_by, updated_at = now()`,
        [
          s.tenantId,
          scope,
          scopeId,
          key,
          JSON.stringify(value),
          (opts.locked ?? false) && scope === "tenant",
          opts.by ?? null,
        ],
      ),
    );
  }

  async delete(s: Subject, target: SettingTarget): Promise<void> {
    await this.db.withTenant(s.tenantId, (q) =>
      q.query(`delete from settings where scope = $1 and scope_id = $2 and key = $3`, [
        target.scope,
        target.scopeId,
        target.key,
      ]),
    );
  }

  private async assertNotLocked(s: Subject, target: SettingTarget): Promise<void> {
    const projectId = target.scope === "project" ? target.scopeId : s.projectId;
    const cur = await this.resolve({ ...s, projectId });
    if (cur.locked.has(target.key) && cur.source[target.key] !== target.scope)
      throw new Error(`setting "${target.key}" is locked by your organization`);
  }
}

// ---------- helpers ----------
function layerSettings(rows: SettingRow[]): ResolvedSettings {
  const values: Record<string, unknown> = { ...SETTING_DEFAULTS };
  const source: Record<string, SettingScope | "default"> = Object.fromEntries(
    Object.keys(SETTING_DEFAULTS).map((k) => [k, "default" as const]),
  );
  const locked = new Set<string>();
  for (const scope of SCOPE_PRECEDENCE) {
    for (const r of rows.filter((x) => x.scope === scope)) {
      if (locked.has(r.key)) continue;
      values[r.key] = r.value;
      source[r.key] = scope;
      if (r.locked) locked.add(r.key);
    }
  }
  return { values, locked, source };
}
