// Periodic housekeeping. Cheap by design: partition drops instead of row deletes for the
// append-only tables; per-tenant content retention only touches tenants storing content.

import { NO_USER_ID } from "../constants/ids.constants.ts";
import { PARTITION_MONTHS_AHEAD } from "../constants/limits.constants.ts";
import type { Services } from "../container.ts";
import { MaintenanceRepo } from "../repositories/maintenance.repository.ts";

// ---------- constants ----------
const MAINTENANCE_INTERVAL_MS = 5 * 60_000;
/** 0 = keep stored content forever. */
const DEFAULT_CONTENT_RETENTION_DAYS = 0;
const DEFAULT_USAGE_RETENTION_MONTHS = 13;

// ---------- types ----------
export interface MaintenanceReport {
  runtimesEvicted: number;
  contentPurged: number;
  approvalsExpired: number;
  deviceCodesPurged: number;
  partitionsDropped: number;
}

// ---------- maintenance ----------
export async function runMaintenance(
  s: Services,
  opts: { usageRetentionMonths?: number } = {},
): Promise<MaintenanceReport> {
  const repo = new MaintenanceRepo(s.db);
  const runtimesEvicted = await s.runtime.sweep();
  await repo.ensurePartitions(PARTITION_MONTHS_AHEAD);
  await repo.purgeSessionEvents();
  const { contentPurged, approvalsExpired } = await purgeTenantData(s);
  const deviceCodesPurged = await s.identity.purgeExpiredDeviceCodes();
  const partitionsDropped = await repo.dropOldPartitions(usageRetentionMonths(opts));
  return {
    runtimesEvicted,
    contentPurged,
    approvalsExpired,
    deviceCodesPurged,
    partitionsDropped,
  };
}

/** Runs maintenance every few minutes, logging (never throwing) failures; returns a stop fn. */
export function scheduleMaintenance(s: Services): () => void {
  const timer = setInterval(() => void maintainAndLog(s), MAINTENANCE_INTERVAL_MS);
  return () => clearInterval(timer);
}

// ---------- helpers ----------
async function maintainAndLog(s: Services): Promise<void> {
  try {
    const report = await runMaintenance(s);
    if (report.contentPurged || report.partitionsDropped)
      console.log("[exa-server] maintenance", report);
  } catch (e) {
    console.error("[exa-server] maintenance failed", e);
  }
}

async function purgeTenantData(
  s: Services,
): Promise<{ contentPurged: number; approvalsExpired: number }> {
  let contentPurged = 0;
  let approvalsExpired = 0;
  for (const tenant of await s.identity.allTenants()) {
    const settings = await s.config.resolveSettings({ tenantId: tenant.id, userId: NO_USER_ID });
    const days = Number(settings.values["retention.contentDays"] ?? DEFAULT_CONTENT_RETENTION_DAYS);
    if (days > 0) contentPurged += await s.sessions.purgeContent(tenant.id, days);
    approvalsExpired += await s.sessions.expireApprovals(tenant.id);
  }
  return { contentPurged, approvalsExpired };
}

function usageRetentionMonths(opts: { usageRetentionMonths?: number }): number {
  if (opts.usageRetentionMonths !== undefined) return opts.usageRetentionMonths;
  return Number(process.env.EXA_USAGE_RETENTION_MONTHS ?? DEFAULT_USAGE_RETENTION_MONTHS);
}
