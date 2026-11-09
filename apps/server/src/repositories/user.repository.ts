// Users. A global table (no RLS), so queries run as the owner.
import { newId } from "@exa/protocol";
import { type Db, users } from "@exa/store";
import { eq, sql } from "drizzle-orm";
import type { User } from "../models/identity.model.ts";

// ---------- user repo ----------
export class UserRepo {
  constructor(private readonly db: Db) {}

  async upsert(email: string, displayName?: string, authSubject?: string): Promise<User> {
    const [row] = await this.db.orm
      .insert(users)
      .values({
        id: newId(),
        email: sql`lower(${email})`,
        displayName: displayName ?? null,
        authSubject: authSubject ?? null,
      })
      .onConflictDoUpdate({
        target: users.email,
        set: {
          displayName: sql`coalesce(excluded.display_name, ${users.displayName})`,
          authSubject: sql`coalesce(${users.authSubject}, excluded.auth_subject)`,
        },
      })
      .returning();
    return userFromRow(row);
  }

  async byId(id: string): Promise<User | null> {
    const [row] = await this.db.orm.select().from(users).where(eq(users.id, id));
    return row ? userFromRow(row) : null;
  }

  async bySubject(sub: string): Promise<User | null> {
    const [row] = await this.db.orm.select().from(users).where(eq(users.authSubject, sub));
    return row ? userFromRow(row) : null;
  }
}

// ---------- helpers ----------
function userFromRow(r: typeof users.$inferSelect): User {
  return { id: r.id, email: r.email, displayName: r.displayName ?? null };
}
