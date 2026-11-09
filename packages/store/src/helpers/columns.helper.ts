// Column types that behave the same on Bun's Postgres driver and on PGlite. Drizzle's built-in
// jsonb double-encodes on Bun SQL (the driver JSON-encodes the already-stringified value), and
// 0.45 has no bytea, so both are defined here.
import { sql } from "drizzle-orm";
import { customType, timestamp } from "drizzle-orm/pg-core";

// ---------- columns ----------
/**
 * jsonb that is always sent as text and cast in SQL, so every driver stores the same object.
 * Reads come back already parsed by the driver.
 */
export const jsonb = <T>(name: string) =>
  customType<{ data: T; driverData: unknown }>({
    dataType: () => "jsonb",
    toDriver: (value) => sql`(${JSON.stringify(value)}::text)::jsonb`,
    fromDriver: (value) => value as T,
  })(name);

/** bytea as a Uint8Array on both drivers. */
export const bytea = customType<{ data: Uint8Array; driverData: Uint8Array }>({
  dataType: () => "bytea",
  toDriver: (value) => Buffer.from(value),
  fromDriver: (value) => new Uint8Array(value),
});

/** `timestamptz`, read as a Date. */
export const timestamptz = (name: string) => timestamp(name, { withTimezone: true });
