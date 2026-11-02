// Read side of telemetry: token/cost usage summaries and the audit trail. Both flush pending
// telemetry first so a caller sees their own most recent activity.

import { isAdmin } from "../helpers/role.helper.ts";
import type { Principal } from "../models/principal.model.ts";
import type { ServiceDeps } from "./service-deps.ts";

// ---------- constants ----------
const AUDIT_PAGE_SIZE = 500;

// ---------- usage service ----------
export class UsageService {
  constructor(private readonly deps: ServiceDeps) {}

  /** The caller's usage; admins may ask for the whole organization. */
  async usage(p: Principal, opts: { days: number; wholeOrg: boolean }) {
    const includeEveryone = opts.wholeOrg && isAdmin(p);
    await this.deps.telemetry.flush();
    return this.deps.telemetry.usageSummary(p.tenantId, {
      userId: includeEveryone ? undefined : p.userId,
      days: opts.days,
    });
  }

  async auditTrail(p: Principal, sessionId: string | undefined) {
    await this.deps.telemetry.flush();
    return this.deps.telemetry.auditTrail(p.tenantId, { sessionId, limit: AUDIT_PAGE_SIZE });
  }
}
