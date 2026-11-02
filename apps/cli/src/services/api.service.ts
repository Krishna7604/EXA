// Typed client for the exa server API (used by the heavy client).

import {
  type AuthorizeRequest,
  type AuthorizeResponse,
  type ExaEvent,
  type MessageWithParts,
  type ModelChunk,
  ModelError,
  type ModelRequest,
  type PermissionReply,
  readNdjson,
  readSse,
  type SessionInfo,
  type SignedPolicyBundle,
} from "@exa/protocol";
import type { AgentRow } from "@exa/store";
import type {
  DeviceStartResult,
  DeviceToken,
  DevLoginResult,
  Me,
  ModelCatalog,
  ProviderKey,
  PublishedSkill,
  UsageRow,
} from "../models/api.model.ts";

// ---------- constants ----------
const SSE_INITIAL_BACKOFF_MS = 500;
const SSE_MAX_BACKOFF_MS = 10_000;
/** Statuses where reconnecting the event stream can't help. */
const SSE_FATAL_STATUSES = new Set([401, 403, 404]);
const HTTP_NO_CONTENT = 204;
const HTTP_TOO_MANY_REQUESTS = 429;
const HTTP_SERVER_ERROR = 500;

// ---------- errors ----------
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly retryable = false,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

// ---------- types ----------
interface RequestOptions {
  signal?: AbortSignal;
  raw?: boolean;
  headers?: Record<string, string>;
}

// ---------- api client ----------

export class ExaApi {
  constructor(
    readonly baseUrl: string,
    private token: string | null,
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  setToken(t: string): void {
    this.token = t;
  }

  // auth
  devLogin(email: string, tenant: string) {
    return this.req<DevLoginResult>("POST", "/v1/auth/dev-login", { email, tenant });
  }
  deviceStart(clientName: string) {
    return this.req<DeviceStartResult>("POST", "/v1/auth/device", { clientName });
  }
  /** Poll the device flow; "pending" until the user approves the code in the browser. */
  async devicePoll(deviceCode: string): Promise<DeviceToken | "pending"> {
    try {
      return await this.req("POST", "/v1/auth/device/token", { deviceCode });
    } catch (e) {
      if (e instanceof ApiError && e.code === "authorization_pending") return "pending";
      throw e;
    }
  }
  createToken(name: string) {
    return this.req<{ id: string; token: string }>("POST", "/v1/tokens", { name });
  }
  me() {
    return this.req<Me>("GET", "/v1/me");
  }
  policyKey() {
    return this.req<{ publicKey: string; keyId: string }>("GET", "/v1/policy/key");
  }
  policy() {
    return this.req<SignedPolicyBundle>("GET", "/v1/policy");
  }
  models() {
    return this.req<ModelCatalog>("GET", "/v1/models");
  }
  keys() {
    return this.req<ProviderKey[]>("GET", "/v1/keys");
  }
  putKey(provider: string, key: string, scope: "user" | "tenant" = "user") {
    return this.req<{ id: string; last4: string }>("PUT", "/v1/keys", { provider, key, scope });
  }
  skills() {
    return this.req<PublishedSkill[]>("GET", "/v1/skills");
  }
  agents() {
    return this.req<AgentRow[]>("GET", "/v1/agents");
  }
  usage(days = 30) {
    return this.req<UsageRow[]>("GET", `/v1/usage?days=${days}`);
  }

  // sessions
  createSession(body: Record<string, unknown>) {
    return this.req<SessionInfo & { permissionMode: string }>("POST", "/v1/sessions", body);
  }
  sessions(limit = 30) {
    return this.req<SessionInfo[]>("GET", `/v1/sessions?limit=${limit}`);
  }
  session(id: string) {
    return this.req<{
      info: SessionInfo & { permissionMode: string };
      messages: MessageWithParts[] | null;
      lastSeq: number;
    }>("GET", `/v1/sessions/${id}`);
  }
  patchSession(id: string, patch: Record<string, unknown>) {
    return this.req<SessionInfo>("PATCH", `/v1/sessions/${id}`, patch);
  }
  deleteSession(id: string) {
    return this.req<void>("DELETE", `/v1/sessions/${id}`);
  }
  lease(id: string, action: "acquire" | "renew" | "release", fencing?: number, ttlMs?: number) {
    return this.req<{ fencing: number; ttlMs: number }>("POST", `/v1/sessions/${id}/lease`, {
      action,
      fencing,
      ttlMs,
    });
  }
  ingest(id: string, body: { fencing: number; events: unknown[]; persist?: unknown[] }) {
    return this.req<{ ok: boolean }>("POST", `/v1/sessions/${id}/ingest`, body);
  }
  reply(sessionId: string, requestId: string, reply: PermissionReply) {
    return this.req<{ ok: boolean }>("POST", `/v1/sessions/${sessionId}/permissions/${requestId}`, {
      reply,
    });
  }
  authorize(body: AuthorizeRequest) {
    return this.req<AuthorizeResponse>("POST", "/v1/authorize", body);
  }

  async *modelStream(req: ModelRequest, signal: AbortSignal): AsyncGenerator<ModelChunk> {
    let res: Response;
    try {
      res = await this.req<Response>("POST", "/v1/model/stream", req, { signal, raw: true });
    } catch (e) {
      if (e instanceof ApiError) throw new ModelError(e.message, e.status, e.retryable);
      throw new ModelError(`cannot reach exa server: ${(e as Error).message}`, 0, true);
    }
    for await (const c of readNdjson<ModelChunk>(res.body!)) yield c;
  }

  /** Long-lived SSE subscription with automatic reconnect + Last-Event-ID resume. */
  async subscribe(
    sessionId: string,
    onEvent: (e: ExaEvent) => void,
    signal: AbortSignal,
  ): Promise<void> {
    let last: number | undefined;
    let backoff = SSE_INITIAL_BACKOFF_MS;
    while (!signal.aborted) {
      try {
        const res = await this.fetchFn(`${this.baseUrl}/v1/sessions/${sessionId}/events`, {
          headers: {
            authorization: `Bearer ${this.token}`,
            ...(last !== undefined ? { "last-event-id": String(last) } : {}),
          },
          signal,
        });
        if (!res.ok || !res.body) throw await toError(res);
        backoff = SSE_INITIAL_BACKOFF_MS;
        for await (const f of readSse(res.body, signal)) {
          if (!f.data) continue;
          const e = JSON.parse(f.data) as ExaEvent;
          if (e.seq) last = e.seq;
          onEvent(e);
        }
      } catch (e) {
        if (signal.aborted) return;
        if (e instanceof ApiError && SSE_FATAL_STATUSES.has(e.status)) return;
        // anything else (network drop, server restart): reconnect after the backoff
      }
      await new Promise((r) => setTimeout(r, backoff));
      backoff = Math.min(backoff * 2, SSE_MAX_BACKOFF_MS);
    }
  }

  /** JSON request with the bearer token; `raw` returns the Response for streaming. */
  private async req<T>(
    method: string,
    path: string,
    body?: unknown,
    opts: RequestOptions = {},
  ): Promise<T> {
    const res = await this.fetchFn(`${this.baseUrl}${path}`, {
      method,
      headers: {
        ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
        ...opts.headers,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: opts.signal,
    });
    if (!res.ok) throw await toError(res);
    if (opts.raw) return res as unknown as T;
    if (res.status === HTTP_NO_CONTENT) return undefined as T;
    return (await res.json()) as T;
  }
}

// ---------- helpers ----------
/** Build an ApiError from a failed response, using the server's error body when present. */
async function toError(res: Response): Promise<ApiError> {
  let code = "http_error";
  let message = `${res.status} ${res.statusText}`;
  let retryable = res.status >= HTTP_SERVER_ERROR || res.status === HTTP_TOO_MANY_REQUESTS;
  try {
    const j = (await res.json()) as {
      error?: { code?: string; message?: string; retryable?: boolean };
    };
    if (j.error) {
      code = j.error.code ?? code;
      message = j.error.message ?? message;
      if (typeof j.error.retryable === "boolean") retryable = j.error.retryable;
    }
  } catch {
    // non-JSON error body: keep the status-line message
  }
  return new ApiError(res.status, code, message, retryable);
}
