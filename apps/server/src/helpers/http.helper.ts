// Request/response helpers for controllers: JSON responses, the JSON error shape, body
// validation with zod, and typed query-string params.
import { isUuid } from "@exa/protocol";
import type { z } from "zod";
import { ERROR_CODES } from "../constants/errors.constants.ts";
import { DEFAULT_MAX_BODY_BYTES } from "../constants/limits.constants.ts";
import type { Ctx } from "../models/http-context.model.ts";
import { HttpError } from "../models/http-error.model.ts";

// ---------- constants ----------
const JSON_CONTENT_TYPE = "application/json; charset=utf-8";

// ---------- responses ----------
export const json = (data: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": JSON_CONTENT_TYPE, ...headers },
  });

export const noContent = () => new Response(null, { status: 204 });

/** Maps any thrown value to the JSON error shape `{ error: { code, message, ...extra } }`. */
export function errorResponse(e: unknown): Response {
  if (e instanceof HttpError)
    return json({ error: { code: e.code, message: e.message, ...e.extra } }, e.status);
  // Errors from lower layers (e.g. the runtime's busy error) may carry their own HTTP status.
  const status = (e as { status?: number })?.status;
  if (typeof status === "number" && status >= 400 && status < 600) {
    return json({ error: { code: ERROR_CODES.upstream, message: (e as Error).message } }, status);
  }
  console.error("[exa-server] unhandled", e);
  return json({ error: { code: ERROR_CODES.internal, message: "internal server error" } }, 500);
}

// ---------- request parsing ----------
/** Reads and validates a JSON body (413 when too large, 400 on bad JSON or schema mismatch). */
export async function body<T extends z.ZodType>(
  ctx: Ctx,
  schema: T,
  maxBytes = DEFAULT_MAX_BODY_BYTES,
): Promise<z.infer<T>> {
  const declaredLength = Number(ctx.req.headers.get("content-length") ?? 0);
  if (declaredLength > maxBytes) throw tooLarge();
  const raw = await readJson(ctx.req, maxBytes);
  const result = schema.safeParse(raw);
  if (!result.success) {
    const message = result.error.issues
      .map((i) => `${i.path.join(".") || "body"}: ${i.message}`)
      .join("; ");
    throw new HttpError(400, message, ERROR_CODES.validation);
  }
  return result.data;
}

/** Positive integer query param, falling back on missing/invalid values and capped at `max`. */
export function queryInt(ctx: Ctx, name: string, fallback: number, max: number): number {
  const parsed = Number(ctx.url.searchParams.get(name) ?? fallback) || fallback;
  return Math.min(parsed, max);
}

/** Query param that must be a UUID; anything else reads as absent (null). */
export function queryUuid(ctx: Ctx, name: string): string | null {
  const value = ctx.url.searchParams.get(name);
  return value && isUuid(value) ? value : null;
}

// ---------- helpers ----------
function tooLarge(): HttpError {
  return new HttpError(413, "request body too large", ERROR_CODES.tooLarge);
}

async function readJson(req: Request, maxBytes: number): Promise<unknown> {
  try {
    const text = await req.text();
    if (text.length > maxBytes) throw tooLarge();
    return text ? JSON.parse(text) : {};
  } catch (e) {
    if (e instanceof HttpError) throw e;
    throw new HttpError(400, "invalid JSON body", ERROR_CODES.badJson);
  }
}
