// Permission rules stored per scope (tenant / project / user); only tenant rules can be locked.
import { newId, type PermissionRule, type RuleScope } from "@exa/protocol";
import { type Db, permissionRules } from "@exa/store";
import { and, eq, inArray, ne, or, type SQL, sql } from "drizzle-orm";
import { NO_PROJECT_ID } from "../constants/ids.constants.ts";
import type { NewRule } from "../models/permission-rule.model.ts";
import type { SettingScope, Subject } from "../models/subject.model.ts";

// ---------- constants ----------
/** Precedence: tenant < project < user. */
const SCOPE_ORDER = sql`case ${permissionRules.scope}
  when 'tenant' then 0 when 'project' then 1 else 2 end`;

// ---------- rules repo ----------
export class PermissionRulesRepo {
  constructor(private readonly db: Db) {}

  /** Rules in precedence order: tenant < project < user (then priority, then age). */
  async list(s: Subject): Promise<PermissionRule[]> {
    const rows = await this.db.withTenant(s.tenantId, (q) =>
      q.orm
        .select()
        .from(permissionRules)
        .where(visibleTo(s))
        .orderBy(
          SCOPE_ORDER,
          permissionRules.priority,
          permissionRules.createdAt,
          permissionRules.id,
        ),
    );
    return rows.map((r) => ({
      id: r.id,
      permission: r.permission,
      pattern: r.pattern,
      action: r.action as PermissionRule["action"],
      scope: r.scope as RuleScope,
      // only tenant rules can be locked
      locked: r.scope === "tenant" && r.locked,
    }));
  }

  async add(s: Subject, r: NewRule, by?: string): Promise<string> {
    const id = newId();
    await this.db.withTenant(s.tenantId, (q) =>
      q.orm.insert(permissionRules).values({
        id,
        tenantId: s.tenantId,
        scope: r.scope,
        scopeId: r.scopeId,
        permission: r.permission,
        pattern: r.pattern,
        action: r.action,
        locked: !!r.locked && r.scope === "tenant",
        priority: r.priority ?? 0,
        createdBy: by ?? null,
      }),
    );
    return id;
  }

  async delete(s: Subject, id: string, allowedScopes: SettingScope[]): Promise<boolean> {
    const rows = await this.db.withTenant(s.tenantId, (q) =>
      q.orm
        .delete(permissionRules)
        .where(
          and(
            eq(permissionRules.id, id),
            inArray(permissionRules.scope, allowedScopes),
            or(ne(permissionRules.scope, "user"), eq(permissionRules.scopeId, s.userId)),
          ),
        )
        .returning({ id: permissionRules.id }),
    );
    return rows.length > 0;
  }
}

// ---------- helpers ----------
/** The tenant's rules, the user's own, and the current project's. */
function visibleTo(s: Subject): SQL | undefined {
  return or(
    and(eq(permissionRules.scope, "tenant"), eq(permissionRules.scopeId, s.tenantId)),
    and(eq(permissionRules.scope, "user"), eq(permissionRules.scopeId, s.userId)),
    and(
      eq(permissionRules.scope, "project"),
      eq(permissionRules.scopeId, s.projectId ?? NO_PROJECT_ID),
    ),
  );
}
