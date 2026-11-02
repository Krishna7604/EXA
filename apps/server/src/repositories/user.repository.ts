// Users. A global table (no RLS), so queries run as the owner.
import { newId } from "@exa/protocol";
import type { Db } from "@exa/store";
import type { User } from "../models/identity.model.ts";

// ---------- user repo ----------
export class UserRepo {
  constructor(private readonly db: Db) {}

  async upsert(email: string, displayName?: string, authSubject?: string): Promise<User> {
    const r = await this.db.query(
      `insert into users (id, email, display_name, auth_subject) values ($1, lower($2), $3, $4)
       on conflict (email) do update set display_name = coalesce(excluded.display_name, users.display_name),
         auth_subject = coalesce(users.auth_subject, excluded.auth_subject)
       returning *`,
      [newId(), email, displayName ?? null, authSubject ?? null],
    );
    return userFromRow(r[0]);
  }

  async byId(id: string): Promise<User | null> {
    const r = await this.db.query(`select * from users where id = $1`, [id]);
    return r[0] ? userFromRow(r[0]) : null;
  }

  async bySubject(sub: string): Promise<User | null> {
    const r = await this.db.query(`select * from users where auth_subject = $1`, [sub]);
    return r[0] ? userFromRow(r[0]) : null;
  }
}

// ---------- helpers ----------
// biome-ignore lint/suspicious/noExplicitAny: raw driver row
function userFromRow(r: any): User {
  return {
    id: r.id,
    email: r.email,
    displayName: r.display_name ?? null,
  };
}
