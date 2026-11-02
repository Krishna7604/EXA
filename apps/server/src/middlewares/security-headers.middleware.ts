// Response headers applied to every response: CORS for allow-listed origins, plus security
// headers the handler didn't set itself.

// ---------- constants ----------
const SECURITY_HEADERS: Record<string, string> = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "x-frame-options": "DENY",
};

const CORS_HEADERS: Record<string, string> = {
  "access-control-allow-headers": "authorization, content-type, last-event-id",
  "access-control-allow-methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
};

// ---------- security headers ----------
export function applySecurityHeaders(req: Request, res: Response, corsOrigins: string[]): Response {
  const origin = req.headers.get("origin");
  if (origin && corsOrigins.includes(origin)) {
    res.headers.set("access-control-allow-origin", origin);
    res.headers.set("vary", "origin");
    for (const [k, v] of Object.entries(CORS_HEADERS)) res.headers.set(k, v);
  }
  for (const [k, v] of Object.entries(SECURITY_HEADERS))
    if (!res.headers.has(k)) res.headers.set(k, v);
  return res;
}
