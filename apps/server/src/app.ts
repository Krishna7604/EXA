// HTTP application: runs the middlewares (rate limits, authentication, security headers) and
// dispatches to the route tables in routes/*. Non-API paths serve the static web client.
import { ERROR_CODES } from "./constants/errors.constants.ts";
import type { Services } from "./container.ts";
import { errorResponse } from "./helpers/http.helper.ts";
import { Router } from "./helpers/router.helper.ts";
import { serveWebClient } from "./helpers/static-files.helper.ts";
import { AuthMiddleware } from "./middlewares/auth.middleware.ts";
import { RateLimitMiddleware } from "./middlewares/rate-limit.middleware.ts";
import { applySecurityHeaders } from "./middlewares/security-headers.middleware.ts";
import type { Ctx } from "./models/http-context.model.ts";
import { HttpError } from "./models/http-error.model.ts";
import { apiRoutes } from "./routes/api.routes.ts";

// ---------- types ----------
type ServerInfo = { requestIP(r: Request): { address: string } | null };

export interface App {
  fetch: (req: Request, server?: ServerInfo) => Promise<Response>;
}

// ---------- app ----------
export function createApp(s: Services): App {
  const router = new Router().addAll(apiRoutes(s));
  const auth = new AuthMiddleware(s.principals);
  const limits = new RateLimitMiddleware();
  const withHeaders = (req: Request, res: Response) =>
    applySecurityHeaders(req, res, s.cfg.corsOrigins);

  async function route(req: Request, url: URL, ip: string): Promise<Response> {
    if (req.method === "OPTIONS") return new Response(null, { status: 204 });
    if (!isApiPath(url.pathname)) return serveWebClient(req, url.pathname);
    const m = router.match(req.method, url.pathname);
    if (!m) throw new HttpError(404, "not found", ERROR_CODES.notFound);
    const ctx: Ctx = { req, url, params: m.params, ip };
    limits.checkAnonymous(url.pathname, ip);
    if (m.route.auth) {
      ctx.principal = await auth.authenticate(req);
      limits.checkUser(url.pathname, ctx.principal.userId);
    }
    return m.route.handler(ctx);
  }

  return {
    async fetch(req, server) {
      const url = new URL(req.url);
      const ip = server?.requestIP(req)?.address ?? "local";
      try {
        return withHeaders(req, await route(req, url, ip));
      } catch (e) {
        return withHeaders(req, errorResponse(e));
      }
    },
  };
}

// ---------- helpers ----------
function isApiPath(pathname: string): boolean {
  return pathname.startsWith("/v1/") || pathname === "/healthz";
}
