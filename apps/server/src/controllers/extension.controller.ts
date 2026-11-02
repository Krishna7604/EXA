// Org/user skill and agent endpoints, shared to every client.
import { api } from "@exa/protocol";
import { body, json, noContent } from "../helpers/http.helper.ts";
import type { ExtensionScope } from "../models/extension.model.ts";
import type { Ctx } from "../models/http-context.model.ts";
import type { ExtensionService } from "../services/extension.service.ts";

// ---------- extension controller ----------
export class ExtensionController {
  constructor(private readonly extensions: ExtensionService) {}

  listSkills = async (ctx: Ctx): Promise<Response> =>
    json(await this.extensions.listSkills(ctx.principal!));

  putSkill = async (ctx: Ctx): Promise<Response> => {
    const b = await body(ctx, api.PutSkillBody);
    return json({ id: await this.extensions.putSkill(ctx.principal!, b) }, 201);
  };

  deleteSkill = async (ctx: Ctx): Promise<Response> => {
    await this.extensions.deleteSkill(ctx.principal!, ctx.params.name, scopeParam(ctx));
    return noContent();
  };

  listAgents = async (ctx: Ctx): Promise<Response> =>
    json(await this.extensions.listAgents(ctx.principal!));

  putAgent = async (ctx: Ctx): Promise<Response> => {
    const b = await body(ctx, api.PutAgentBody);
    return json({ id: await this.extensions.putAgent(ctx.principal!, b) }, 201);
  };

  deleteAgent = async (ctx: Ctx): Promise<Response> => {
    await this.extensions.deleteAgent(ctx.principal!, ctx.params.name, scopeParam(ctx));
    return noContent();
  };
}

// ---------- helpers ----------
/** `?scope=tenant` targets the org-wide copy; anything else means the user's own. */
function scopeParam(ctx: Ctx): ExtensionScope {
  return ctx.url.searchParams.get("scope") === "tenant" ? "tenant" : "user";
}
