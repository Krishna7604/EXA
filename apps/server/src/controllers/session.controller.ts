// Session endpoints: CRUD, server-loop controls (prompt, abort, revert, compact), approval
// replies and the live event stream (SSE).
import type { EventBus } from "@exa/core";
import { api } from "@exa/protocol";
import { body, json, noContent, queryInt, queryUuid } from "../helpers/http.helper.ts";
import { sessionEventStream } from "../helpers/sse.helper.ts";
import type { Ctx } from "../models/http-context.model.ts";
import type { SessionService } from "../services/session.service.ts";

// ---------- constants ----------
const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 200;
const PROMPT_WRONG_HOST = "this session runs on a client; prompt it there";
const REVERT_WRONG_HOST = "revert runs on the client for client-loop sessions";
const WRONG_HOST = "wrong host";

// ---------- session controller ----------
export class SessionController {
  constructor(
    private readonly sessions: SessionService,
    private readonly bus: EventBus,
    private readonly maxBodyBytes: number,
  ) {}

  create = async (ctx: Ctx): Promise<Response> => {
    const b = await body(ctx, api.CreateSessionBody);
    return json(await this.sessions.create(ctx.principal!, b), 201);
  };

  list = async (ctx: Ctx): Promise<Response> => {
    const limit = queryInt(ctx, "limit", DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT);
    const parentId = queryUuid(ctx, "parentId");
    return json(await this.sessions.list(ctx.principal!, { limit, parentId }));
  };

  get = async (ctx: Ctx): Promise<Response> => {
    const p = ctx.principal!;
    const sess = await this.sessions.loadReadable(p, ctx.params.id);
    return json(await this.sessions.detail(p, sess));
  };

  update = async (ctx: Ctx): Promise<Response> => {
    const p = ctx.principal!;
    const sess = await this.sessions.loadWritable(p, ctx.params.id);
    const b = await body(ctx, api.PatchSessionBody);
    return json(await this.sessions.update(p, sess, b));
  };

  forget = async (ctx: Ctx): Promise<Response> => {
    const p = ctx.principal!;
    const sess = await this.sessions.loadWritable(p, ctx.params.id);
    await this.sessions.forget(p, sess);
    return noContent();
  };

  prompt = async (ctx: Ctx): Promise<Response> => {
    const p = ctx.principal!;
    const sess = await this.sessions.loadServerLoop(p, ctx.params.id, PROMPT_WRONG_HOST);
    const b = await body(ctx, api.PromptBody, this.maxBodyBytes);
    await this.sessions.prompt(p, sess, b);
    return json({ accepted: true }, 202);
  };

  abort = async (ctx: Ctx): Promise<Response> => {
    const p = ctx.principal!;
    const sess = await this.sessions.loadWritable(p, ctx.params.id);
    return json(this.sessions.abort(p, sess));
  };

  revert = async (ctx: Ctx): Promise<Response> => {
    const p = ctx.principal!;
    const sess = await this.sessions.loadServerLoop(p, ctx.params.id, REVERT_WRONG_HOST);
    const b = await body(ctx, api.RevertBody);
    await this.sessions.revert(p, sess, b);
    return json({ ok: true });
  };

  unrevert = async (ctx: Ctx): Promise<Response> => {
    const p = ctx.principal!;
    const sess = await this.sessions.loadServerLoop(p, ctx.params.id, WRONG_HOST);
    await this.sessions.unrevert(p, sess);
    return json({ ok: true });
  };

  compact = async (ctx: Ctx): Promise<Response> => {
    const p = ctx.principal!;
    const sess = await this.sessions.loadServerLoop(p, ctx.params.id, WRONG_HOST);
    return json({ compacted: await this.sessions.compact(p, sess) });
  };

  /** Approvals: the first answer from any attached client wins. */
  replyPermission = async (ctx: Ctx): Promise<Response> => {
    const p = ctx.principal!;
    const sess = await this.sessions.loadWritable(p, ctx.params.id);
    const b = await body(ctx, api.PermissionReplyBody);
    await this.sessions.replyPermission(p, sess, ctx.params.reqId, b.reply);
    return json({ ok: true });
  };

  /** Live events (SSE). Resume with Last-Event-ID or ?after=. */
  events = async (ctx: Ctx): Promise<Response> => {
    const sess = await this.sessions.loadReadable(ctx.principal!, ctx.params.id);
    const afterRaw = ctx.req.headers.get("last-event-id") ?? ctx.url.searchParams.get("after");
    const after = afterRaw !== null && afterRaw !== "" ? Number(afterRaw) : undefined;
    return sessionEventStream(this.bus, sess.id, { after, signal: ctx.req.signal });
  };
}
