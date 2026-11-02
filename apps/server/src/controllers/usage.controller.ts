// Usage summary and audit trail endpoints.
import { isUuid } from "@exa/protocol";
import { json, queryInt } from "../helpers/http.helper.ts";
import { requireAdmin } from "../helpers/role.helper.ts";
import type { Ctx } from "../models/http-context.model.ts";
import type { UsageService } from "../services/usage.service.ts";

// ---------- constants ----------
const DEFAULT_USAGE_DAYS = 30;
const MAX_USAGE_DAYS = 365;

// ---------- usage controller ----------
export class UsageController {
  constructor(private readonly usage: UsageService) {}

  summary = async (ctx: Ctx): Promise<Response> => {
    const days = queryInt(ctx, "days", DEFAULT_USAGE_DAYS, MAX_USAGE_DAYS);
    const wholeOrg = ctx.url.searchParams.get("all") === "1";
    return json(await this.usage.usage(ctx.principal!, { days, wholeOrg }));
  };

  audit = async (ctx: Ctx): Promise<Response> => {
    const p = ctx.principal!;
    requireAdmin(p);
    const sessionId = ctx.url.searchParams.get("sessionId");
    return json(await this.usage.auditTrail(p, isUuid(sessionId) ? sessionId : undefined));
  };
}
