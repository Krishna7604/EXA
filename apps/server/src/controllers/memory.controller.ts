// Long-term memory and chat history search endpoints.
import { api } from "@exa/protocol";
import type { z } from "zod";
import { ERROR_CODES } from "../constants/errors.constants.ts";
import { body, json, noContent, queryInt } from "../helpers/http.helper.ts";
import type { Ctx } from "../models/http-context.model.ts";
import { HttpError } from "../models/http-error.model.ts";
import { MAX_MEMORIES_PER_USER, type MemoryService } from "../services/memory.service.ts";

// ---------- constants ----------
const DEFAULT_LIST_LIMIT = 100;

// ---------- types ----------
type SearchInput = z.infer<typeof api.SearchQuery>;

// ---------- memory controller ----------
export class MemoryController {
  constructor(private readonly memory: MemoryService) {}

  /** Newest first; with `?q=` a ranked search instead. */
  list = async (ctx: Ctx): Promise<Response> => {
    if (ctx.url.searchParams.has("q")) {
      const s = searchQuery(ctx);
      return json(await this.memory.search(ctx.principal!, s.q, s.limit));
    }
    const limit = queryInt(ctx, "limit", DEFAULT_LIST_LIMIT, MAX_MEMORIES_PER_USER);
    return json(await this.memory.list(ctx.principal!, limit));
  };

  create = async (ctx: Ctx): Promise<Response> => {
    const b = await body(ctx, api.PutMemoryBody);
    return json(await this.memory.create(ctx.principal!, b), 201);
  };

  update = async (ctx: Ctx): Promise<Response> => {
    const b = await body(ctx, api.PutMemoryBody);
    return json(await this.memory.update(ctx.principal!, ctx.params.id, b));
  };

  remove = async (ctx: Ctx): Promise<Response> => {
    await this.memory.remove(ctx.principal!, ctx.params.id);
    return noContent();
  };

  /** Full-text search over the caller's stored chats. */
  searchChats = async (ctx: Ctx): Promise<Response> => {
    const s = searchQuery(ctx);
    return json(await this.memory.searchChats(ctx.principal!, s.q, s.limit));
  };
}

// ---------- helpers ----------
/** `?q=&limit=` validated with the shared schema (400 on a missing/empty `q`). */
function searchQuery(ctx: Ctx): SearchInput {
  const result = api.SearchQuery.safeParse(Object.fromEntries(ctx.url.searchParams));
  if (result.success) return result.data;
  const message = result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
  throw new HttpError(400, message, ERROR_CODES.validation);
}
