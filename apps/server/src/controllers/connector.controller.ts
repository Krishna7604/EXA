// Connector endpoints: the caller's and the org's remote MCP servers, and a connection test.
import { api } from "@exa/protocol";
import { body, json, noContent } from "../helpers/http.helper.ts";
import type { Ctx } from "../models/http-context.model.ts";
import type { ConnectorService } from "../services/connector.service.ts";

// ---------- connector controller ----------
export class ConnectorController {
  constructor(private readonly connectors: ConnectorService) {}

  list = async (ctx: Ctx): Promise<Response> => json(await this.connectors.list(ctx.principal!));

  create = async (ctx: Ctx): Promise<Response> => {
    const b = await body(ctx, api.PutConnectorBody);
    return json(await this.connectors.create(ctx.principal!, b), 201);
  };

  update = async (ctx: Ctx): Promise<Response> => {
    const b = await body(ctx, api.PatchConnectorBody);
    return json(await this.connectors.update(ctx.principal!, ctx.params.id, b));
  };

  remove = async (ctx: Ctx): Promise<Response> => {
    await this.connectors.remove(ctx.principal!, ctx.params.id);
    return noContent();
  };

  test = async (ctx: Ctx): Promise<Response> =>
    json(await this.connectors.test(ctx.principal!, ctx.params.id));
}
