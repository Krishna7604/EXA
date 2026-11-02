// Gateway + policy endpoints used by client loops: model streaming (NDJSON), the model
// catalog, the signed policy bundle and its public key, and server-side tool authorization.
import { api, type ModelRequest } from "@exa/protocol";
import { body, json } from "../helpers/http.helper.ts";
import { ndjsonResponse } from "../helpers/ndjson.helper.ts";
import type { Ctx } from "../models/http-context.model.ts";
import type { ModelService } from "../services/model.service.ts";

// ---------- model controller ----------
export class ModelController {
  constructor(
    private readonly models: ModelService,
    private readonly maxBodyBytes: number,
  ) {}

  stream = async (ctx: Ctx): Promise<Response> => {
    const req = (await body(ctx, api.ModelRequestBody, this.maxBodyBytes)) as ModelRequest;
    const ac = new AbortController();
    ctx.req.signal.addEventListener("abort", () => ac.abort(), { once: true });
    const opened = await this.models.openStream(ctx.principal!, req, ac.signal);
    return ndjsonResponse(opened, ac);
  };

  catalog = async (ctx: Ctx): Promise<Response> => json(await this.models.catalog(ctx.principal!));

  policyKey = (): Response => json(this.models.policyKey());

  policy = async (ctx: Ctx): Promise<Response> => {
    const projectId = ctx.url.searchParams.get("projectId");
    return json(await this.models.policyBundle(ctx.principal!, projectId));
  };

  authorize = async (ctx: Ctx): Promise<Response> => {
    const b = await body(ctx, api.AuthorizeBody);
    return json(await this.models.authorize(ctx.principal!, b));
  };
}
