// Sign-in endpoints: auth config, dev login, OIDC exchange and the CLI device-code flow.
import { api } from "@exa/protocol";
import { body, json } from "../helpers/http.helper.ts";
import type { Ctx } from "../models/http-context.model.ts";
import type { AuthService } from "../services/auth.service.ts";

// ---------- auth controller ----------
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  config = (): Response => json(this.auth.authConfig());

  /** Creates the tenant/user on first use. Disabled unless EXA_DEV_AUTH=1. */
  devLogin = async (ctx: Ctx): Promise<Response> => {
    this.auth.assertDevLoginEnabled();
    const b = await body(ctx, api.DevLoginBody);
    return json(await this.auth.devLogin(b));
  };

  /** Exchange a verified ID token from your IdP for an exa session. */
  oidcLogin = async (ctx: Ctx): Promise<Response> => {
    this.auth.assertOidcEnabled();
    const b = await body(ctx, api.OidcLoginBody);
    return json(await this.auth.oidcLogin(b));
  };

  startDevice = async (ctx: Ctx): Promise<Response> =>
    json(await this.auth.startDevice(await body(ctx, api.DeviceStartBody)));

  pollDevice = async (ctx: Ctx): Promise<Response> =>
    json(await this.auth.pollDevice(await body(ctx, api.DevicePollBody)));

  approveDevice = async (ctx: Ctx): Promise<Response> => {
    const b = await body(ctx, api.DeviceApproveBody);
    await this.auth.approveDevice(ctx.principal!, b);
    return json({ ok: true });
  };
}
