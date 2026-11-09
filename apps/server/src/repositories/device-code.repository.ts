// CLI device authorization codes: created by the CLI, approved by the user in the browser,
// then exchanged exactly once for an API token. Global table.
import { type Db, type DbTx, deviceCodes } from "@exa/store";
import { and, eq, gt, lt, sql } from "drizzle-orm";
import { hashToken, randomToken } from "../helpers/tokens.helper.ts";
import type { DevicePollResult, NewDeviceCode } from "../models/identity.model.ts";

// ---------- constants ----------
/** Unambiguous consonants for human-typed device user codes ("BCDF-GHJK"). */
const USER_CODE_ALPHABET = "BCDFGHJKLMNPQRSTVWXZ";
const USER_CODE_LENGTH = 8;
const DEVICE_CODE_PREFIX = "dc";
const DEVICE_CODE_BYTES = 32;
/** How long a new code stays usable (10 minutes). */
const DEVICE_CODE_TTL_SECONDS = 600;

// ---------- device code repo ----------
export class DeviceCodeRepo {
  constructor(private readonly db: Db) {}

  async create(clientName: string): Promise<NewDeviceCode> {
    const deviceCode = randomToken(DEVICE_CODE_PREFIX, DEVICE_CODE_BYTES);
    const userCode = newUserCode();
    await this.db.orm.insert(deviceCodes).values({
      deviceCodeHash: hashToken(deviceCode),
      userCode,
      clientName,
      expiresAt: sql`now() + make_interval(secs => ${DEVICE_CODE_TTL_SECONDS})`,
    });
    return { deviceCode, userCode, expiresIn: DEVICE_CODE_TTL_SECONDS };
  }

  async approve(userCode: string, tenantId: string, userId: string): Promise<boolean> {
    const rows = await this.db.orm
      .update(deviceCodes)
      .set({ status: "approved", tenantId, userId })
      .where(
        and(
          eq(deviceCodes.userCode, sql`upper(${userCode.trim()})`),
          eq(deviceCodes.status, "pending"),
          gt(deviceCodes.expiresAt, sql`now()`),
        ),
      )
      .returning({ userCode: deviceCodes.userCode });
    return rows.length > 0;
  }

  /** Returns the approval once (then marks it consumed); "pending" / "expired" / "denied" otherwise. */
  async poll(deviceCode: string): Promise<DevicePollResult> {
    const hash = hashToken(deviceCode);
    return this.db.tx(async (q) => {
      const row = await lockDeviceCode(q, hash);
      if (!row || row.status === "consumed") return { status: "expired" as const };
      if (row.status === "denied") return { status: "denied" as const };
      if (row.expired) return { status: "expired" as const };
      if (row.status !== "approved") return { status: "pending" as const };
      await q.orm
        .update(deviceCodes)
        .set({ status: "consumed" })
        .where(eq(deviceCodes.deviceCodeHash, hash));
      return {
        status: "approved" as const,
        tenantId: row.tenantId as string,
        userId: row.userId as string,
        clientName: row.clientName as string,
      };
    });
  }

  async purgeExpired(): Promise<number> {
    const rows = await this.db.orm
      .delete(deviceCodes)
      .where(lt(deviceCodes.expiresAt, sql`now() - interval '1 day'`))
      .returning({ userCode: deviceCodes.userCode });
    return rows.length;
  }
}

// ---------- helpers ----------
/** The code's row, locked for the rest of the transaction so it is exchanged only once. */
async function lockDeviceCode(q: DbTx, hash: Uint8Array) {
  const [row] = await q.orm
    .select({
      status: deviceCodes.status,
      tenantId: deviceCodes.tenantId,
      userId: deviceCodes.userId,
      clientName: deviceCodes.clientName,
      expired: sql<boolean>`${deviceCodes.expiresAt} < now()`,
    })
    .from(deviceCodes)
    .where(eq(deviceCodes.deviceCodeHash, hash))
    .for("update");
  return row;
}

/** e.g. "BCDF-GHJK": short enough to type, from an unambiguous alphabet. */
function newUserCode(): string {
  const b = crypto.getRandomValues(new Uint8Array(USER_CODE_LENGTH));
  return Array.from(b, (x) => USER_CODE_ALPHABET[x % USER_CODE_ALPHABET.length])
    .join("")
    .replace(/^(.{4})/, "$1-");
}
