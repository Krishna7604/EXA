// Web search providers behind the core SearchPort: Tavily, Brave and SearXNG when configured,
// else a best-effort keyless DuckDuckGo HTML fallback. Every provider's results are normalized
// to plain-text, length-capped SearchResults, and every request times out on its own.

import type { SearchPort } from "@exa/core";
import type { SearchResult } from "@exa/protocol";
import { htmlToText } from "./html-to-text.ts";

// ---------- constants ----------
const TAVILY_URL = "https://api.tavily.com/search";
const BRAVE_URL = "https://api.search.brave.com/res/v1/web/search";
const DUCKDUCKGO_URL = "https://html.duckduckgo.com/html/";
const SEARCH_TIMEOUT_MS = 10_000;
const MS_PER_SECOND = 1000;
const MAX_SNIPPET_CHARS = 400;
const MAX_TITLE_CHARS = 200;
const ERROR_BODY_PREVIEW_CHARS = 200;
/** Brave rejects `count` above this. */
const BRAVE_MAX_COUNT = 20;
const ELLIPSIS = "…";
const USER_AGENT = "exa-agent/2.0 (+https://github.com/exa-harness)";
const HTTP_FORBIDDEN = 403;
const HTTP_UNAUTHORIZED = 401;
const PROVIDERS = ["tavily", "brave", "searxng", "duckduckgo"] as const;
const OFF = "off";

const DDG_TITLE_LINK = /<a\b([^>]*\bclass="[^"]*\bresult__a\b[^"]*"[^>]*)>([\s\S]*?)<\/a>/gi;
const DDG_SNIPPET =
  /<(a|div|td|span)\b[^>]*\bclass="[^"]*\bresult__snippet\b[^"]*"[^>]*>([\s\S]*?)<\/\1>/i;
const DDG_BOT_CHECK = /anomaly-modal|challenge-form/i;
const HREF_ATTR = /\bhref="([^"]*)"/i;
const DDG_REDIRECT_PARAM = "uddg";
const DDG_HOST_SUFFIX = "duckduckgo.com";

// ---------- types ----------
/** Which provider to use and its credentials (the server's `cfg.search`, or CLI env). */
export interface SearchProviderConfig {
  /** Force one: "tavily" | "brave" | "searxng" | "duckduckgo" | "off". */
  provider?: string;
  tavilyKey?: string;
  braveKey?: string;
  searxngUrl?: string;
}

export type SearchProviderName = (typeof PROVIDERS)[number];

interface SearchRequest {
  query: string;
  limit: number;
  signal: AbortSignal;
  fetchFn: typeof fetch;
}

type ProviderSearch = (req: SearchRequest) => Promise<SearchResult[]>;

interface RawResult {
  title?: string;
  url?: string;
  snippet?: string;
  published?: string | null;
}

interface TavilyResponse {
  results?: Array<{ title?: string; url?: string; content?: string; published_date?: string }>;
}

interface BraveResponse {
  web?: {
    results?: Array<{ title?: string; url?: string; description?: string; page_age?: string }>;
  };
}

interface SearxngResponse {
  results?: Array<{ title?: string; url?: string; content?: string; publishedDate?: string }>;
}

// ---------- errors ----------
/** A provider answered with an error, or a provider is misconfigured. Messages never hold keys. */
export class SearchProviderError extends Error {
  override readonly name = "SearchProviderError";
}

// ---------- search port ----------
/**
 * The configured search provider, or null when search is turned off. A forced provider
 * without its credentials, or an unknown provider name, is a configuration error (throws).
 */
export function createSearchPort(
  cfg: SearchProviderConfig,
  fetchFn: typeof fetch = fetch,
): SearchPort | null {
  const name = pickSearchProvider(cfg);
  if (!name) return null;
  return portFor(name, providerSearch(name, cfg), fetchFn);
}

/** Forced provider first ("off" → null); otherwise tavily → brave → searxng → duckduckgo. */
export function pickSearchProvider(cfg: SearchProviderConfig): SearchProviderName | null {
  const forced = cfg.provider?.trim().toLowerCase();
  if (forced === OFF) return null;
  if (forced) return knownProvider(forced);
  if (cfg.tavilyKey) return "tavily";
  if (cfg.braveKey) return "brave";
  if (cfg.searxngUrl) return "searxng";
  return "duckduckgo";
}

// ---------- providers ----------
async function searchTavily(key: string, req: SearchRequest): Promise<SearchResult[]> {
  const res = await req.fetchFn(TAVILY_URL, {
    method: "POST",
    headers: {
      authorization: `Bearer ${key}`,
      "content-type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify({ query: req.query, max_results: req.limit, search_depth: "basic" }),
    signal: req.signal,
  });
  await assertOk(res, "Tavily");
  const data = (await res.json()) as TavilyResponse;
  return normalizeAll(
    (data.results ?? []).map((r) => ({
      title: r.title,
      url: r.url,
      snippet: r.content,
      published: r.published_date,
    })),
  );
}

async function searchBrave(key: string, req: SearchRequest): Promise<SearchResult[]> {
  const url = new URL(BRAVE_URL);
  url.searchParams.set("q", req.query);
  url.searchParams.set("count", String(Math.min(req.limit, BRAVE_MAX_COUNT)));
  const res = await req.fetchFn(url, {
    headers: { accept: "application/json", "x-subscription-token": key },
    signal: req.signal,
  });
  await assertOk(res, "Brave");
  const data = (await res.json()) as BraveResponse;
  return normalizeAll(
    (data.web?.results ?? []).map((r) => ({
      title: r.title,
      url: r.url,
      snippet: r.description,
      published: r.page_age,
    })),
  );
}

async function searchSearxng(baseUrl: string, req: SearchRequest): Promise<SearchResult[]> {
  const url = new URL(`${baseUrl.replace(/\/+$/, "")}/search`);
  url.searchParams.set("q", req.query);
  url.searchParams.set("format", "json");
  const res = await req.fetchFn(url, {
    headers: { accept: "application/json", "user-agent": USER_AGENT },
    signal: req.signal,
  });
  if (res.status === HTTP_FORBIDDEN)
    throw new SearchProviderError(
      "SearXNG search failed: HTTP 403. JSON output is disabled on that instance; add `json` " +
        "to `search.formats` in its settings.yml.",
    );
  await assertOk(res, "SearXNG");
  const data = (await res.json()) as SearxngResponse;
  return normalizeAll(
    (data.results ?? []).map((r) => ({
      title: r.title,
      url: r.url,
      snippet: r.content,
      published: r.publishedDate,
    })),
  );
}

/** Keyless and best-effort: scrapes DuckDuckGo's HTML endpoint (no JS). */
async function searchDuckDuckGo(req: SearchRequest): Promise<SearchResult[]> {
  const res = await req.fetchFn(DUCKDUCKGO_URL, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      accept: "text/html",
      "user-agent": USER_AGENT,
    },
    body: new URLSearchParams({ q: req.query }).toString(),
    signal: req.signal,
  });
  await assertOk(res, "DuckDuckGo");
  const html = await res.text();
  const results = parseDuckDuckGoHtml(html);
  if (!results.length && DDG_BOT_CHECK.test(html))
    throw new SearchProviderError(
      "DuckDuckGo search failed: it answered with a bot check. Configure TAVILY_API_KEY, " +
        "BRAVE_SEARCH_API_KEY or EXA_SEARXNG_URL for reliable search.",
    );
  return results;
}

/** Result links and snippets from DuckDuckGo's HTML page, redirect links resolved. */
export function parseDuckDuckGoHtml(html: string): SearchResult[] {
  const titles = [...html.matchAll(DDG_TITLE_LINK)];
  const raw = titles.map((m, i) => {
    const start = (m.index ?? 0) + m[0].length;
    const end = titles[i + 1]?.index ?? html.length;
    const snippet = html.slice(start, end).match(DDG_SNIPPET)?.[2];
    return { title: m[2], url: duckDuckGoTarget(m[1]) ?? undefined, snippet };
  });
  return normalizeAll(raw);
}

// ---------- helpers ----------
function knownProvider(name: string): SearchProviderName {
  const known = PROVIDERS.find((p) => p === name);
  if (!known)
    throw new SearchProviderError(
      `unknown search provider "${name}" (use ${PROVIDERS.join(", ")} or ${OFF})`,
    );
  return known;
}

function providerSearch(name: SearchProviderName, cfg: SearchProviderConfig): ProviderSearch {
  switch (name) {
    case "tavily": {
      const key = required(cfg.tavilyKey, name, "TAVILY_API_KEY");
      return (req) => searchTavily(key, req);
    }
    case "brave": {
      const key = required(cfg.braveKey, name, "BRAVE_SEARCH_API_KEY");
      return (req) => searchBrave(key, req);
    }
    case "searxng": {
      const url = required(cfg.searxngUrl, name, "EXA_SEARXNG_URL");
      if (!isHttpUrl(url))
        throw new SearchProviderError(`EXA_SEARXNG_URL is not an http(s) URL: ${url}`);
      return (req) => searchSearxng(url, req);
    }
    case "duckduckgo":
      return searchDuckDuckGo;
  }
}

function required(value: string | undefined, provider: string, envName: string): string {
  if (!value) throw new SearchProviderError(`search provider "${provider}" needs ${envName}`);
  return value;
}

/** Wraps a provider with the timeout, the result cap and readable errors. */
function portFor(name: SearchProviderName, run: ProviderSearch, fetchFn: typeof fetch): SearchPort {
  return {
    provider: name,
    async search(query: string, opts: { limit: number; signal: AbortSignal }) {
      const timeout = AbortSignal.timeout(SEARCH_TIMEOUT_MS);
      const signal = AbortSignal.any([opts.signal, timeout]);
      try {
        const results = await run({ query, limit: opts.limit, signal, fetchFn });
        return results.slice(0, opts.limit);
      } catch (err) {
        if (opts.signal.aborted) throw err;
        throw searchFailure(name, err, timeout.aborted);
      }
    },
  };
}

function searchFailure(name: SearchProviderName, err: unknown, timedOut: boolean): Error {
  if (timedOut)
    return new SearchProviderError(
      `${name} search timed out after ${SEARCH_TIMEOUT_MS / MS_PER_SECOND} s`,
    );
  const e = err instanceof Error ? err : new Error(String(err));
  if (e instanceof SearchProviderError) return e;
  return new SearchProviderError(`${name} search failed: ${e.message}`);
}

/** Throws `<Provider> search failed: HTTP <status> …` for any non-2xx response. */
async function assertOk(res: Response, label: string): Promise<void> {
  if (res.ok) return;
  const hint =
    res.status === HTTP_UNAUTHORIZED || res.status === HTTP_FORBIDDEN ? " (check the API key)" : "";
  const body = (await res.text().catch(() => "")).slice(0, ERROR_BODY_PREVIEW_CHARS).trim();
  const detail = body ? `: ${htmlToText(body)}` : "";
  throw new SearchProviderError(`${label} search failed: HTTP ${res.status}${hint}${detail}`);
}

function normalizeAll(raw: RawResult[]): SearchResult[] {
  return raw.flatMap((r) => {
    const result = normalize(r);
    return result ? [result] : [];
  });
}

/** Plain text, capped; results without an http(s) URL are dropped. */
function normalize(r: RawResult): SearchResult | null {
  const url = r.url?.trim();
  if (!url || !isHttpUrl(url)) return null;
  const title = plainText(r.title ?? "", MAX_TITLE_CHARS) || url;
  const result: SearchResult = {
    title,
    url,
    snippet: plainText(r.snippet ?? "", MAX_SNIPPET_CHARS),
  };
  const published = isoDate(r.published);
  if (published) result.published = published;
  return result;
}

function plainText(html: string, max: number): string {
  const text = htmlToText(html).replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}${ELLIPSIS}` : text;
}

function isoDate(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  const time = Date.parse(value);
  return Number.isNaN(time) ? undefined : new Date(time).toISOString();
}

function isHttpUrl(value: string): boolean {
  try {
    const u = new URL(value);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    // not a URL at all: the result is dropped
    return false;
  }
}

/** The real target of a DuckDuckGo result link (`//duckduckgo.com/l/?uddg=<url>`); ads → null. */
function duckDuckGoTarget(attrs: string): string | null {
  const href = attrs.match(HREF_ATTR)?.[1];
  if (!href) return null;
  let link: URL;
  try {
    link = new URL(htmlToText(href), DUCKDUCKGO_URL);
  } catch {
    // malformed href: skip this result
    return null;
  }
  const target = link.searchParams.get(DDG_REDIRECT_PARAM);
  if (target) return target;
  const isDuckDuckGo =
    link.hostname === DDG_HOST_SUFFIX || link.hostname.endsWith(`.${DDG_HOST_SUFFIX}`);
  return isDuckDuckGo ? null : link.href;
}
