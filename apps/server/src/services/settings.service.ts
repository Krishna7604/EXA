// Org/project/user settings, permission rules and quotas. Every change invalidates the
// tenant's cached lookups and is audited; org-wide changes bump the policy version so client
// loops refetch their signed bundle.

import { type api, isUuid } from "@exa/protocol";
import type { z } from "zod";
import { ERROR_CODES } from "../constants/errors.constants.ts";
import { isAdmin } from "../helpers/role.helper.ts";
import { HttpError } from "../models/http-error.model.ts";
import type { Principal } from "../models/principal.model.ts";
import type { SettingScope } from "../models/subject.model.ts";
import type { ServiceDeps } from "./service-deps.ts";

// ---------- types ----------
type PutSettingInput = z.infer<typeof api.PutSettingBody>;
type PutRuleInput = z.infer<typeof api.PutRuleBody>;
type PutQuotaInput = z.infer<typeof api.PutQuotaBody>;

// ---------- settings service ----------
export class SettingsService {
  constructor(private readonly deps: ServiceDeps) {}

  /** Effective settings for the user (and project, when given), with lock + source info. */
  async resolved(p: Principal, projectId: string | null) {
    const settings = await this.deps.config.resolveSettings({
      tenantId: p.tenantId,
      userId: p.userId,
      projectId,
    });
    return { values: settings.values, locked: [...settings.locked], source: settings.source };
  }

  async put(p: Principal, input: PutSettingInput): Promise<void> {
    const scopeId = resolveScopeId(p, input.scope, input.scopeId);
    try {
      await this.deps.config.putSetting(
        { tenantId: p.tenantId, userId: p.userId },
        input.scope,
        scopeId,
        input.key,
        input.value,
        input.locked,
        p.userId,
      );
    } catch (e) {
      // The repo refuses to override a value locked at a higher scope.
      throw new HttpError(403, (e as Error).message, ERROR_CODES.locked);
    }
    this.deps.invalidate(p.tenantId);
    if (input.scope === "tenant") await this.deps.identity.bumpPolicyVersion(p.tenantId);
    this.deps.telemetry.recordAudit({
      tenantId: p.tenantId,
      actorUserId: p.userId,
      action: "setting.changed",
      target: `${input.scope}:${input.key}`,
      decision: input.locked ? "locked" : undefined,
    });
  }

  listRules(p: Principal) {
    return this.deps.config.rules({ tenantId: p.tenantId, userId: p.userId });
  }

  async addRule(p: Principal, input: PutRuleInput): Promise<string> {
    const id = await this.deps.config.addRule(
      { tenantId: p.tenantId, userId: p.userId },
      {
        scope: input.scope,
        scopeId: resolveScopeId(p, input.scope, input.scopeId),
        permission: input.permission,
        pattern: input.pattern,
        action: input.action,
        locked: input.locked,
        priority: input.priority,
      },
      p.userId,
    );
    this.deps.invalidate(p.tenantId);
    await this.deps.identity.bumpPolicyVersion(p.tenantId);
    this.deps.telemetry.recordAudit({
      tenantId: p.tenantId,
      actorUserId: p.userId,
      action: "rule.added",
      target: `${input.scope}:${input.permission}=${input.pattern}`,
      decision: input.action,
    });
    return id;
  }

  /** Admins may delete rules at any scope; everyone else only their own user rules. */
  async deleteRule(p: Principal, ruleId: string): Promise<void> {
    const scopes: SettingScope[] = isAdmin(p) ? ["tenant", "project", "user"] : ["user"];
    const owner = { tenantId: p.tenantId, userId: p.userId };
    const deleted = await this.deps.config.deleteRule(owner, ruleId, scopes);
    if (!deleted) throw new HttpError(404, "rule not found", ERROR_CODES.notFound);
    await this.deps.identity.bumpPolicyVersion(p.tenantId);
    this.deps.telemetry.recordAudit({
      tenantId: p.tenantId,
      actorUserId: p.userId,
      action: "rule.deleted",
      target: ruleId,
    });
  }

  /** Tenant quotas apply to the caller's org; user quotas need an explicit subject. */
  async setQuota(p: Principal, input: PutQuotaInput): Promise<void> {
    const subjectId = input.subjectScope === "tenant" ? p.tenantId : input.subjectId;
    if (!subjectId)
      throw new HttpError(400, "subjectId required for user quotas", ERROR_CODES.validation);
    await this.deps.config.setQuota(p.tenantId, { ...input, subjectId });
    this.deps.invalidate(p.tenantId);
    this.deps.telemetry.recordAudit({
      tenantId: p.tenantId,
      actorUserId: p.userId,
      action: "quota.set",
      target: `${input.subjectScope}:${subjectId}:${input.period}`,
    });
  }
}

// ---------- helpers ----------
/** The id a setting/rule is stored under; org and project scopes are admin-only. */
function resolveScopeId(
  p: Principal,
  scope: "tenant" | "project" | "user",
  given?: string,
): string {
  if (scope === "tenant") {
    if (!isAdmin(p))
      throw new HttpError(
        403,
        "only admins can change organization settings",
        ERROR_CODES.forbidden,
      );
    return p.tenantId;
  }
  if (scope === "project") {
    if (!isAdmin(p))
      throw new HttpError(403, "only admins can change project settings", ERROR_CODES.forbidden);
    if (!given || !isUuid(given))
      throw new HttpError(400, "scopeId (project id) required", ERROR_CODES.validation);
    return given;
  }
  return p.userId;
}
