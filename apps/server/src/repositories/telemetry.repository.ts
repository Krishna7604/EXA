// Usage + audit writer. Append-only, batched (flush every second or every N rows) so the hot
// path never waits on the database. The SQL lives in usage.repository / audit.repository.
import type { Db } from "@exa/store";
import type { AuditRow, UsageRow } from "../models/telemetry.model.ts";
import { auditTrail, insertAuditRows } from "./audit.repository.ts";
import { insertUsageEvents, upsertRollups, usageSummary } from "./usage.repository.ts";

// ---------- constants ----------
const DEFAULT_FLUSH_INTERVAL_MS = 1000;
const DEFAULT_MAX_BATCH = 200;

// ---------- types ----------
interface TelemetryOpts {
  intervalMs?: number;
  maxBatch?: number;
  onError?: (e: unknown) => void;
}

interface TenantBatch {
  usage: UsageRow[];
  audit: AuditRow[];
}

// ---------- telemetry writer ----------
export class TelemetryWriter {
  private usage: UsageRow[] = [];
  private audit: AuditRow[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private flushing: Promise<void> | null = null;

  constructor(
    private readonly db: Db,
    private readonly opts: TelemetryOpts = {},
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(
      () => void this.flush(),
      this.opts.intervalMs ?? DEFAULT_FLUSH_INTERVAL_MS,
    );
    (this.timer as any).unref?.();
  }

  recordUsage(u: UsageRow): void {
    this.usage.push(u);
    if (this.usage.length >= this.maxBatch()) void this.flush();
  }

  recordAudit(a: AuditRow): void {
    this.audit.push({ ...a, time: a.time ?? Date.now() });
    if (this.audit.length >= this.maxBatch()) void this.flush();
  }

  async flush(): Promise<void> {
    if (this.flushing) return this.flushing;
    const usage = this.usage.splice(0);
    const audit = this.audit.splice(0);
    if (!usage.length && !audit.length) return;
    this.flushing = (async () => {
      try {
        await this.writeAll(usage, audit);
      } catch (e) {
        this.opts.onError?.(e);
      } finally {
        this.flushing = null;
      }
    })();
    return this.flushing;
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.flush();
  }

  async usageSummary(tenantId: string, opts: { userId?: string; days?: number } = {}) {
    return usageSummary(this.db, tenantId, opts);
  }

  async auditTrail(tenantId: string, opts: { sessionId?: string; limit?: number } = {}) {
    return auditTrail(this.db, tenantId, opts);
  }

  private maxBatch(): number {
    return this.opts.maxBatch ?? DEFAULT_MAX_BATCH;
  }

  private async writeAll(usage: UsageRow[], audit: AuditRow[]): Promise<void> {
    for (const [tenantId, batch] of groupByTenant(usage, audit)) {
      await this.db.withTenant(tenantId, async (q) => {
        if (batch.usage.length) {
          await insertUsageEvents(q, tenantId, batch.usage);
          await upsertRollups(q, tenantId, batch.usage);
        }
        if (batch.audit.length) await insertAuditRows(q, tenantId, batch.audit);
      });
    }
  }
}

// ---------- helpers ----------
function groupByTenant(usage: UsageRow[], audit: AuditRow[]): Map<string, TenantBatch> {
  const byTenant = new Map<string, TenantBatch>();
  const batchFor = (tenantId: string): TenantBatch => {
    let batch = byTenant.get(tenantId);
    if (!batch) {
      batch = { usage: [], audit: [] };
      byTenant.set(tenantId, batch);
    }
    return batch;
  };
  for (const u of usage) batchFor(u.tenantId).usage.push(u);
  for (const a of audit) batchFor(a.tenantId).audit.push(a);
  return byTenant;
}
