// Serves the single-page web client from apps/web/public: unknown paths fall back to
// index.html, and HTML gets a strict Content-Security-Policy.
import { existsSync } from "node:fs";
import { join, normalize } from "node:path";
import { ERROR_CODES } from "../constants/errors.constants.ts";
import { HttpError } from "../models/http-error.model.ts";

// ---------- constants ----------
const WEB_ROOT = join(import.meta.dir, "..", "..", "..", "web", "public");
const CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'";

// ---------- web client ----------
/** Single-page web client: unknown paths fall back to index.html. */
export async function serveWebClient(req: Request, pathname: string): Promise<Response> {
  if (req.method !== "GET" && req.method !== "HEAD")
    throw new HttpError(404, "not found", ERROR_CODES.notFound);
  const res = (await serveStatic(pathname)) ?? (await serveStatic("/"));
  return res ?? new Response("exa server", { status: 200 });
}

// ---------- helpers ----------
async function serveStatic(pathname: string): Promise<Response | null> {
  const rel = pathname === "/" ? "index.html" : pathname.slice(1);
  const file = normalize(join(WEB_ROOT, rel));
  if (!file.startsWith(WEB_ROOT) || !existsSync(file)) return null;
  const headers: Record<string, string> = {
    "cache-control": rel === "index.html" ? "no-cache" : "public, max-age=300",
  };
  if (rel.endsWith(".html")) headers["content-security-policy"] = CSP;
  return new Response(Bun.file(file), { headers });
}
