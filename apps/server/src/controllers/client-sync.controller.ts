// Client-loop endpoints: the driving lease and event ingest from heavy clients.
import { api } from "@exa/protocol";
import { body, json, noContent } from "../helpers/http.helper.ts";
import type { Ctx } from "../models/http-context.model.ts";
import type { ClientSyncService } from "../services/client-sync.service.ts";
import type { SessionService } from "../services/session.service.ts";

// ---------- constants ----------
const LEASE_WRONG_HOST = "server-loop sessions are leased by the server";
const INGEST_WRONG_HOST = "only client-loop sessions ingest events";

// ---------- client sync controller ----------
export class ClientSyncController {
  constructor(
    private readonly sessions: SessionService,
    private readonly sync: ClientSyncService,
    private readonly maxBodyBytes: number,
  ) {}

  lease = async (ctx: Ctx): Promise<Response> => {
    const p = ctx.principal!;
    const sess = await this.sessions.loadClientLoop(p, ctx.params.id, LEASE_WRONG_HOST);
    const b = await body(ctx, api.LeaseBody);
    const lease = await this.sync.lease(p, sess, b);
    return lease ? json(lease) : noContent();
  };

  ingest = async (ctx: Ctx): Promise<Response> => {
    const p = ctx.principal!;
    const sess = await this.sessions.loadClientLoop(p, ctx.params.id, INGEST_WRONG_HOST);
    const b = await body(ctx, api.ClientEventsBody, this.maxBodyBytes);
    return json(await this.sync.ingest(p, sess, b));
  };
}
