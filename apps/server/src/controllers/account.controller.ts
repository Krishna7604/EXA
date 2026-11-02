// Account endpoints: the current user, personal API tokens and the org member list.
import { api } from "@exa/protocol";
import { body, json, noContent } from "../helpers/http.helper.ts";
import { requireAdmin } from "../helpers/role.helper.ts";
import type { Ctx } from "../models/http-context.model.ts";
import type { AccountService } from "../services/account.service.ts";

// ---------- account controller ----------
export class AccountController {
  constructor(private readonly account: AccountService) {}

  me = async (ctx: Ctx): Promise<Response> => json(await this.account.me(ctx.principal!));

  createToken = async (ctx: Ctx): Promise<Response> => {
    const b = await body(ctx, api.CreateApiTokenBody);
    return json(await this.account.createToken(ctx.principal!, b), 201);
  };

  listTokens = async (ctx: Ctx): Promise<Response> =>
    json(await this.account.listTokens(ctx.principal!));

  revokeToken = async (ctx: Ctx): Promise<Response> => {
    await this.account.revokeToken(ctx.principal!, ctx.params.id);
    return noContent();
  };

  listMembers = async (ctx: Ctx): Promise<Response> => {
    const p = ctx.principal!;
    requireAdmin(p);
    return json(await this.account.listMembers(p));
  };

  addMember = async (ctx: Ctx): Promise<Response> => {
    const p = ctx.principal!;
    requireAdmin(p);
    const b = await body(ctx, api.AddMemberBody);
    return json(await this.account.addMember(p, b), 201);
  };
}
