// Settings, permission-rule and quota endpoints.
import { api } from "@exa/protocol";
import { body, json, noContent, queryUuid } from "../helpers/http.helper.ts";
import { requireAdmin } from "../helpers/role.helper.ts";
import type { Ctx } from "../models/http-context.model.ts";
import type { SettingsService } from "../services/settings.service.ts";

// ---------- settings controller ----------
export class SettingsController {
  constructor(private readonly settings: SettingsService) {}

  resolved = async (ctx: Ctx): Promise<Response> => {
    const projectId = queryUuid(ctx, "projectId");
    return json(await this.settings.resolved(ctx.principal!, projectId));
  };

  put = async (ctx: Ctx): Promise<Response> => {
    const b = await body(ctx, api.PutSettingBody);
    await this.settings.put(ctx.principal!, b);
    return json({ ok: true });
  };

  listRules = async (ctx: Ctx): Promise<Response> =>
    json(await this.settings.listRules(ctx.principal!));

  addRule = async (ctx: Ctx): Promise<Response> => {
    const b = await body(ctx, api.PutRuleBody);
    return json({ id: await this.settings.addRule(ctx.principal!, b) }, 201);
  };

  deleteRule = async (ctx: Ctx): Promise<Response> => {
    await this.settings.deleteRule(ctx.principal!, ctx.params.id);
    return noContent();
  };

  setQuota = async (ctx: Ctx): Promise<Response> => {
    const p = ctx.principal!;
    requireAdmin(p);
    const b = await body(ctx, api.PutQuotaBody);
    await this.settings.setQuota(p, b);
    return json({ ok: true });
  };
}
