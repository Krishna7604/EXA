// Org/user-scoped skills and agent definitions (shared across all of a tenant's clients).
import { newId } from "@exa/protocol";
import type { Db } from "@exa/store";
import type { AgentRow, ExtensionScope, SkillRow } from "../models/extension.model.ts";
import type { Subject } from "../models/subject.model.ts";

// ---------- constants ----------
/** Rows visible to a subject: the tenant's own plus the user's own ($1 = tenant, $2 = user). */
const VISIBLE_TO_SUBJECT = `((scope = 'tenant' and scope_id = $1) or (scope = 'user' and scope_id = $2))`;

// ---------- extensions repo ----------
export class ExtensionsRepo {
  constructor(private readonly db: Db) {}

  /** User definitions override org ones with the same name. */
  async skills(s: Subject): Promise<SkillRow[]> {
    const rows = await this.db.withTenant(s.tenantId, (q) =>
      q.query<any>(
        `select id, scope, name, description, body, version from skills where enabled and ${VISIBLE_TO_SUBJECT} order by case scope when 'user' then 0 else 1 end, name`,
        [s.tenantId, s.userId],
      ),
    );
    return firstByName(rows);
  }

  async putSkill(
    s: Subject,
    scope: ExtensionScope,
    sk: { name: string; description: string; body: string },
  ): Promise<string> {
    const id = newId();
    await this.db.withTenant(s.tenantId, (q) =>
      q.query(
        `insert into skills (id, tenant_id, scope, scope_id, name, description, body) values ($1,$2,$3,$4,$5,$6,$7)
         on conflict (tenant_id, scope, scope_id, name) do update set description = excluded.description, body = excluded.body,
           version = skills.version + 1, enabled = true`,
        [id, s.tenantId, scope, scopeIdFor(s, scope), sk.name, sk.description, sk.body],
      ),
    );
    return id;
  }

  async deleteSkill(s: Subject, name: string, scope: ExtensionScope): Promise<boolean> {
    const r = await this.db.withTenant(s.tenantId, (q) =>
      q.query(`delete from skills where name = $1 and scope = $2 and scope_id = $3 returning id`, [
        name,
        scope,
        scopeIdFor(s, scope),
      ]),
    );
    return r.length > 0;
  }

  async agents(s: Subject): Promise<AgentRow[]> {
    const rows = await this.db.withTenant(s.tenantId, (q) =>
      q.query<any>(
        `select id, scope, name, description, mode, hidden, prompt, permission, model, tier, temperature, steps from agent_definitions
         where enabled and ${VISIBLE_TO_SUBJECT} order by case scope when 'user' then 0 else 1 end, name`,
        [s.tenantId, s.userId],
      ),
    );
    return firstByName(rows).map((r) => ({
      ...r,
      temperature: r.temperature === null ? null : Number(r.temperature),
    }));
  }

  async putAgent(
    s: Subject,
    scope: ExtensionScope,
    a: Omit<AgentRow, "id" | "scope">,
  ): Promise<string> {
    const id = newId();
    await this.db.withTenant(s.tenantId, (q) =>
      q.query(
        `insert into agent_definitions (id, tenant_id, scope, scope_id, name, description, mode, hidden, prompt, permission, model, tier, temperature, steps)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,($10::text)::jsonb,$11,$12,$13,$14)
         on conflict (tenant_id, scope, scope_id, name) do update set description = excluded.description, mode = excluded.mode,
           hidden = excluded.hidden, prompt = excluded.prompt, permission = excluded.permission, model = excluded.model,
           tier = excluded.tier, temperature = excluded.temperature, steps = excluded.steps, enabled = true`,
        [
          id,
          s.tenantId,
          scope,
          scopeIdFor(s, scope),
          a.name,
          a.description,
          a.mode,
          a.hidden,
          a.prompt,
          a.permission ? JSON.stringify(a.permission) : null,
          a.model,
          a.tier,
          a.temperature,
          a.steps,
        ],
      ),
    );
    return id;
  }

  async deleteAgent(s: Subject, name: string, scope: ExtensionScope): Promise<boolean> {
    const r = await this.db.withTenant(s.tenantId, (q) =>
      q.query(
        `delete from agent_definitions where name = $1 and scope = $2 and scope_id = $3 returning id`,
        [name, scope, scopeIdFor(s, scope)],
      ),
    );
    return r.length > 0;
  }
}

// ---------- helpers ----------
function scopeIdFor(s: Subject, scope: ExtensionScope): string {
  return scope === "tenant" ? s.tenantId : s.userId;
}

/** Rows arrive user-first, so keeping the first of each name lets user definitions win. */
function firstByName<T extends { name: string }>(rows: T[]): T[] {
  const seen = new Set<string>();
  return rows.filter((r) => {
    if (seen.has(r.name)) return false;
    seen.add(r.name);
    return true;
  });
}
