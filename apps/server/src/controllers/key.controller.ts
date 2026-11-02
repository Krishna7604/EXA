// Bring-your-own provider key endpoints.
import { api } from "@exa/protocol";
import { body, json, noContent } from "../helpers/http.helper.ts";
import type { Ctx } from "../models/http-context.model.ts";
import type { KeyService } from "../services/key.service.ts";

// ---------- key controller ----------
export class KeyController {
  constructor(private readonly keys: KeyService) {}

  list = async (ctx: Ctx): Promise<Response> => json(await this.keys.list(ctx.principal!));

  /** BYOK must be enabled before the body is even read (503 otherwise). */
  put = async (ctx: Ctx): Promise<Response> => {
    this.keys.assertEnabled();
    const b = await body(ctx, api.PutProviderKeyBody);
    return json(await this.keys.put(ctx.principal!, b), 201);
  };

  revoke = async (ctx: Ctx): Promise<Response> => {
    await this.keys.revoke(ctx.principal!, ctx.params.id);
    return noContent();
  };
}
