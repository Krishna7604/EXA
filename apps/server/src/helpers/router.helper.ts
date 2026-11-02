// Minimal path router on top of Bun's fetch handler: `/:name` segments become params, HEAD is
// served by GET, and a path that exists for another method answers 405. No framework.
import { ERROR_CODES } from "../constants/errors.constants.ts";
import type { Handler, RouteDef } from "../models/http-context.model.ts";
import { HttpError } from "../models/http-error.model.ts";

// ---------- types ----------
interface Route {
  method: string;
  pattern: RegExp;
  keys: string[];
  handler: Handler;
  auth: boolean;
}

// ---------- router ----------
export class Router {
  private readonly routes: Route[] = [];

  /** Registers every row of a route table, in order. */
  addAll(table: RouteDef[]): this {
    for (const r of table) this.add(r.method, r.path, r.handler, { auth: r.auth });
    return this;
  }

  /** Registers a route; `/:name` segments become params. Routes need auth unless opted out. */
  add(method: string, path: string, handler: Handler, opts: { auth?: boolean } = {}): this {
    const keys: string[] = [];
    const source = path.replace(/\/:([a-zA-Z_]+)/g, (_m, key) => {
      keys.push(key);
      return "/([^/]+)";
    });
    const pattern = new RegExp(`^${source}/?$`);
    this.routes.push({ method, pattern, keys, handler, auth: opts.auth ?? true });
    return this;
  }

  /** Null when no path matches; throws 405 when the path exists but not for this method. */
  match(method: string, pathname: string): { route: Route; params: Record<string, string> } | null {
    let pathMatched = false;
    for (const route of this.routes) {
      const m = pathname.match(route.pattern);
      if (!m) continue;
      pathMatched = true;
      if (!methodMatches(route.method, method)) continue;
      const params: Record<string, string> = {};
      for (const [i, key] of route.keys.entries()) params[key] = decodeURIComponent(m[i + 1]);
      return { route, params };
    }
    if (pathMatched) throw new HttpError(405, "method not allowed", ERROR_CODES.methodNotAllowed);
    return null;
  }
}

// ---------- helpers ----------
/** HEAD is served by the GET handler. */
function methodMatches(routeMethod: string, method: string): boolean {
  return routeMethod === method || (method === "HEAD" && routeMethod === "GET");
}
