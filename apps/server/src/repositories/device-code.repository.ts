// CLI device authorization codes: created by the CLI, approved by the user in the browser,
// then exchanged exactly once for an API token. Global table.
import type { Db } from "@exa/store";
import { hashToken, randomToken } from "../helpers/tokens.helper.ts";
import type { DevicePollResult, NewDeviceCode } from "../models/identity.model.ts";

// ---------- constants ----------
/** Unambiguous consonants for human-typed device user codes ("BCDF-GHJK"). */
const USER_CODE_ALPHABET = "BCDFGHJKLMNPQRSTVWXZ";
const USER_CODE_LENGTH = 8;
const DEVICE_CODE_PREFIX = "dc";
const DEVICE_CODE_BYTES = 32;
/** Must match the `interval '10 minutes'` in create's SQL. */
const DEVICE_CODE_TTL_SECONDS = 600;

// ---------- device code repo ----------
export class DeviceCodeRepo {
  constructor(private readonly db: Db) {}

  async create(clientName: string): Promise<NewDeviceCode> {
    const deviceCode = randomToken(DEVICE_CODE_PREFIX, DEVICE_CODE_BYTES);
    const userCode = newUserCode();
    await this.db.query(
      `insert into device_codes (device_code_hash, user_code, client_name, expires_at) values ($1,$2,$3, now() + interval '10 minutes')`,
      [hashToken(deviceCode), userCode, clientName],
    );
    return { deviceCode, userCode, expiresIn: DEVICE_CODE_TTL_SECONDS };
  }

  async approve(userCode: string, tenantId: string, userId: string): Promise<boolean> {
    const r = await this.db.query(
      `update device_codes set status = 'approved', tenant_id = $2, user_id = $3
       where user_code = upper($1) and status = 'pending' and expires_at > now() returning user_code`,
      [userCode.trim(), tenantId, userId],
    );
    return r.length > 0;
  }

  /** Returns the approval once (then marks it consumed); "pending" / "expired" / "denied" otherwise. */
  async poll(deviceCode: string): Promise<DevicePollResult> {
    return this.db.tx(async (q) => {
      const r = await q.query<any>(
        `select status, tenant_id, user_id, client_name, expires_at < now() as expired from device_codes where device_code_hash = $1 for update`,
        [hashToken(deviceCode)],
      );
      const row = r[0];
      if (!row || row.status === "consumed") return { status: "expired" as const };
      if (row.status === "denied") return { status: "denied" as const };
      if (row.expired) return { status: "expired" as const };
      if (row.status !== "approved") return { status: "pending" as const };
      await q.query(`update device_codes set status = 'consumed' where device_code_hash = $1`, [
        hashToken(deviceCode),
      ]);
      return {
        status: "approved" as const,
        tenantId: row.tenant_id as string,
        userId: row.user_id as string,
        clientName: row.client_name as string,
      };
    });
  }

  async purgeExpired(): Promise<number> {
    const rows = await this.db.query(
      `delete from device_codes where expires_at < now() - interval '1 day' returning user_code`,
    );
    return rows.length;
  }
}

// ---------- helpers ----------
/** e.g. "BCDF-GHJK": short enough to type, from an unambiguous alphabet. */
function newUserCode(): string {
  const b = crypto.getRandomValues(new Uint8Array(USER_CODE_LENGTH));
  return Array.from(b, (x) => USER_CODE_ALPHABET[x % USER_CODE_ALPHABET.length])
    .join("")
    .replace(/^(.{4})/, "$1-");
}
