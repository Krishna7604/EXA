// Permission rules stored per scope (tenant / project / user); only tenant rules can be locked.
import { newId, type PermissionRule, type RuleScope } from "@exa/protocol";
import type { Db } from "@exa/store";
import { NO_PROJECT_ID } from "../constants/ids.constants.ts";
import type { NewRule } from "../models/permission-rule.model.ts";
import type { SettingScope, Subject } from "../models/subject.model.ts";

// ---------- rules repo ----------
export class PermissionRulesRepo {
  constructor(private readonly db: Db) {}

  /** Rules in precedence order: tenant < project < user (then priority, then age). */
  async list(s: Subject): Promise<PermissionRule[]> {
    const rows = await this.db.withTenant(s.tenantId, (q) =>
      q.query<any>(
        `select * from permission_rules
         where (scope = 'tenant' and scope_id = $1) or (scope = 'user' and scope_id = $2) or (scope = 'project' and scope_id = $3)
         order by case scope when 'tenant' then 0 when 'project' then 1 else 2 end, priority, created_at, id`,
        [s.tenantId, s.userId, s.projectId ?? NO_PROJECT_ID],
      ),
    );
    return rows.map((r) => ({
      id: r.id,
      permission: r.permission,
      pattern: r.pattern,
      action: r.action,
      scope: r.scope as RuleScope,
      // only tenant rules can be locked
      locked: r.scope === "tenant" && r.locked,
    }));
  }

  async add(s: Subject, r: NewRule, by?: string): Promise<string> {
    const id = newId();
    await this.db.withTenant(s.tenantId, (q) =>
      q.query(
        `insert into permission_rules (id, tenant_id, scope, scope_id, permission, pattern, action, locked, priority, created_by)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [
          id,
          s.tenantId,
          r.scope,
          r.scopeId,
          r.permission,
          r.pattern,
          r.action,
          !!r.locked && r.scope === "tenant",
          r.priority ?? 0,
          by ?? null,
        ],
      ),
    );
    return id;
  }

  async delete(s: Subject, id: string, allowedScopes: SettingScope[]): Promise<boolean> {
    const r = await this.db.withTenant(s.tenantId, (q) =>
      q.query(
        `delete from permission_rules where id = $1 and scope in (select jsonb_array_elements_text(($2::text)::jsonb)) and (scope <> 'user' or scope_id = $3) returning id`,
        [id, JSON.stringify(allowedScopes), s.userId],
      ),
    );
    return r.length > 0;
  }
}
