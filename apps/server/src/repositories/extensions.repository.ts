// Org/user-scoped skills and agent definitions (shared across all of a tenant's clients).
import { newId } from "@exa/protocol";
import { agentDefinitions, type Db, skills } from "@exa/store";
import { and, eq, or, type SQL, sql } from "drizzle-orm";
import type { AgentRow, ExtensionScope, SkillRow } from "../models/extension.model.ts";
import type { Subject } from "../models/subject.model.ts";

// ---------- types ----------
/** The scope columns shared by the skills and agent_definitions tables. */
type ScopedTable = typeof skills | typeof agentDefinitions;

// ---------- extensions repo ----------
export class ExtensionsRepo {
  constructor(private readonly db: Db) {}

  /** User definitions override org ones with the same name. */
  async skills(s: Subject): Promise<SkillRow[]> {
    const rows = await this.db.withTenant(s.tenantId, (q) =>
      q.orm
        .select({
          id: skills.id,
          scope: skills.scope,
          name: skills.name,
          description: skills.description,
          body: skills.body,
          version: skills.version,
        })
        .from(skills)
        .where(and(eq(skills.enabled, true), visibleTo(skills, s)))
        .orderBy(userFirst(skills), skills.name),
    );
    return firstByName(rows as SkillRow[]);
  }

  async putSkill(
    s: Subject,
    scope: ExtensionScope,
    sk: { name: string; description: string; body: string },
  ): Promise<string> {
    const id = newId();
    const scopeId = scopeIdFor(s, scope);
    const { name, description, body } = sk;
    await this.db.withTenant(s.tenantId, (q) =>
      q.orm
        .insert(skills)
        .values({ id, tenantId: s.tenantId, scope, scopeId, name, description, body })
        .onConflictDoUpdate({
          target: [skills.tenantId, skills.scope, skills.scopeId, skills.name],
          set: {
            description: sql`excluded.description`,
            body: sql`excluded.body`,
            version: sql`${skills.version} + 1`,
            enabled: true,
          },
        }),
    );
    return id;
  }

  async deleteSkill(s: Subject, name: string, scope: ExtensionScope): Promise<boolean> {
    const rows = await this.db.withTenant(s.tenantId, (q) =>
      q.orm
        .delete(skills)
        .where(and(eq(skills.name, name), ownedBy(skills, s, scope)))
        .returning({ id: skills.id }),
    );
    return rows.length > 0;
  }

  async agents(s: Subject): Promise<AgentRow[]> {
    const rows = await this.db.withTenant(s.tenantId, (q) =>
      q.orm
        .select({
          id: agentDefinitions.id,
          scope: agentDefinitions.scope,
          name: agentDefinitions.name,
          description: agentDefinitions.description,
          mode: agentDefinitions.mode,
          hidden: agentDefinitions.hidden,
          prompt: agentDefinitions.prompt,
          permission: agentDefinitions.permission,
          model: agentDefinitions.model,
          tier: agentDefinitions.tier,
          temperature: agentDefinitions.temperature,
          steps: agentDefinitions.steps,
        })
        .from(agentDefinitions)
        .where(and(eq(agentDefinitions.enabled, true), visibleTo(agentDefinitions, s)))
        .orderBy(userFirst(agentDefinitions), agentDefinitions.name),
    );
    return firstByName(rows as AgentRow[]);
  }

  async putAgent(
    s: Subject,
    scope: ExtensionScope,
    a: Omit<AgentRow, "id" | "scope">,
  ): Promise<string> {
    const id = newId();
    const scopeId = scopeIdFor(s, scope);
    await this.db.withTenant(s.tenantId, (q) =>
      q.orm
        .insert(agentDefinitions)
        .values({ id, tenantId: s.tenantId, scope, scopeId, ...pickAgent(a) })
        .onConflictDoUpdate({
          target: [
            agentDefinitions.tenantId,
            agentDefinitions.scope,
            agentDefinitions.scopeId,
            agentDefinitions.name,
          ],
          set: {
            description: sql`excluded.description`,
            mode: sql`excluded.mode`,
            hidden: sql`excluded.hidden`,
            prompt: sql`excluded.prompt`,
            permission: sql`excluded.permission`,
            model: sql`excluded.model`,
            tier: sql`excluded.tier`,
            temperature: sql`excluded.temperature`,
            steps: sql`excluded.steps`,
            enabled: true,
          },
        }),
    );
    return id;
  }

  async deleteAgent(s: Subject, name: string, scope: ExtensionScope): Promise<boolean> {
    const rows = await this.db.withTenant(s.tenantId, (q) =>
      q.orm
        .delete(agentDefinitions)
        .where(and(eq(agentDefinitions.name, name), ownedBy(agentDefinitions, s, scope)))
        .returning({ id: agentDefinitions.id }),
    );
    return rows.length > 0;
  }
}

// ---------- helpers ----------
function scopeIdFor(s: Subject, scope: ExtensionScope): string {
  return scope === "tenant" ? s.tenantId : s.userId;
}

/** Rows visible to a subject: the tenant's own plus the user's own. */
function visibleTo(t: ScopedTable, s: Subject): SQL | undefined {
  return or(
    and(eq(t.scope, "tenant"), eq(t.scopeId, s.tenantId)),
    and(eq(t.scope, "user"), eq(t.scopeId, s.userId)),
  );
}

/** The one row of `scope` that belongs to the subject. */
function ownedBy(t: ScopedTable, s: Subject, scope: ExtensionScope): SQL | undefined {
  return and(eq(t.scope, scope), eq(t.scopeId, scopeIdFor(s, scope)));
}

/** Sort key putting user definitions ahead of tenant ones. */
function userFirst(t: ScopedTable): SQL {
  return sql`case ${t.scope} when 'user' then 0 else 1 end`;
}

/** Only the writable agent fields (callers may pass a wider object). */
function pickAgent(a: Omit<AgentRow, "id" | "scope">) {
  return {
    name: a.name,
    description: a.description,
    mode: a.mode,
    hidden: a.hidden,
    prompt: a.prompt,
    permission: a.permission || null,
    model: a.model,
    tier: a.tier,
    temperature: a.temperature,
    steps: a.steps,
  };
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
