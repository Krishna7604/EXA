// Request context handed to controllers, and the shape of one route-table entry.
import type { Principal } from "./principal.model.ts";

// ---------- types ----------
export interface Ctx<P = Record<string, string>> {
  req: Request;
  url: URL;
  params: P;
  /** Set by the auth middleware. */
  principal?: Principal;
  ip: string;
}

export type Handler = (ctx: Ctx) => Promise<Response> | Response;

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

/** One row of a route table. Routes need auth unless `auth: false`. */
export interface RouteDef {
  method: HttpMethod;
  path: string;
  handler: Handler;
  auth?: boolean;
}
