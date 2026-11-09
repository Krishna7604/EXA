import { describe, expect, test } from "bun:test";
import type { SearchPort, ToolContext } from "@exa/core";
import {
  createSearchPort,
  parseDuckDuckGoHtml,
  pickSearchProvider,
  SearchProviderError,
  websearchTool,
} from "../index.ts";

interface Captured {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
}

/** A fetch stub that records the request and answers with `respond`. */
function stubFetch(respond: (req: Captured) => Response) {
  const calls: Captured[] = [];
  const fetchFn = (async (input: string | URL, init?: RequestInit) => {
    const req = {
      url: String(input),
      method: init?.method ?? "GET",
      headers: headerRecord(init?.headers),
      body: String(init?.body ?? ""),
    };
    calls.push(req);
    return respond(req);
  }) as unknown as typeof fetch;
  return { fetchFn, calls };
}

function headerRecord(init: HeadersInit | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  new Headers(init).forEach((value, key) => {
    out[key] = value;
  });
  return out;
}

const jsonResponse = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

const opts = (limit = 5) => ({ limit, signal: new AbortController().signal });

describe("provider selection", () => {
  test("tavily → brave → searxng → duckduckgo, first configured wins", () => {
    const all = { tavilyKey: "t", braveKey: "b", searxngUrl: "https://sx.example" };
    expect(pickSearchProvider(all)).toBe("tavily");
    expect(pickSearchProvider({ ...all, tavilyKey: undefined })).toBe("brave");
    expect(pickSearchProvider({ searxngUrl: "https://sx.example" })).toBe("searxng");
    expect(pickSearchProvider({})).toBe("duckduckgo");
  });

  test("a forced provider wins; off disables search; unknown or keyless forced is an error", () => {
    expect(pickSearchProvider({ provider: "Brave", tavilyKey: "t" })).toBe("brave");
    expect(pickSearchProvider({ provider: "duckduckgo", tavilyKey: "t" })).toBe("duckduckgo");
    expect(pickSearchProvider({ provider: "off", tavilyKey: "t" })).toBeNull();
    expect(createSearchPort({ provider: "off" })).toBeNull();
    expect(() => createSearchPort({ provider: "bing" })).toThrow('unknown search provider "bing"');
    expect(() => createSearchPort({ provider: "tavily" })).toThrow("TAVILY_API_KEY");
    expect(() => createSearchPort({ provider: "searxng", searxngUrl: "ftp://x" })).toThrow(
      SearchProviderError,
    );
    expect(createSearchPort({ braveKey: "b" })?.provider).toBe("brave");
  });
});

describe("tavily", () => {
  test("POSTs the query with a bearer key and normalizes results", async () => {
    const { fetchFn, calls } = stubFetch(() =>
      jsonResponse({
        results: [
          {
            title: "Bun &amp; TypeScript",
            url: "https://bun.sh/docs",
            content: "Fast <em>all-in-one</em>   runtime",
            published_date: "2026-10-01",
          },
          { title: "no url", content: "dropped" },
          { title: "Second", url: "https://example.com/2", content: "two" },
        ],
      }),
    );
    const port = createSearchPort({ tavilyKey: "tv-secret" }, fetchFn)!;
    const results = await port.search("bun runtime", opts(5));
    expect(calls[0].url).toBe("https://api.tavily.com/search");
    expect(calls[0].method).toBe("POST");
    expect(calls[0].headers.authorization).toBe("Bearer tv-secret");
    expect(JSON.parse(calls[0].body)).toEqual({
      query: "bun runtime",
      max_results: 5,
      search_depth: "basic",
    });
    expect(results).toEqual([
      {
        title: "Bun & TypeScript",
        url: "https://bun.sh/docs",
        snippet: "Fast all-in-one runtime",
        published: "2026-10-01T00:00:00.000Z",
      },
      { title: "Second", url: "https://example.com/2", snippet: "two" },
    ]);
  });

  test("long snippets are capped and results are cut to the limit", async () => {
    const long = "word ".repeat(400);
    const many = Array.from({ length: 8 }, (_, i) => ({
      title: `r${i}`,
      url: `https://example.com/${i}`,
      content: long,
    }));
    const { fetchFn } = stubFetch(() => jsonResponse({ results: many }));
    const results = await createSearchPort({ tavilyKey: "k" }, fetchFn)!.search("q", opts(3));
    expect(results.length).toBe(3);
    expect(results[0].snippet.length).toBeLessThanOrEqual(400);
    expect(results[0].snippet.endsWith("…")).toBe(true);
  });
});

describe("brave", () => {
  test("GETs with the subscription token and strips <strong> from descriptions", async () => {
    const { fetchFn, calls } = stubFetch(() =>
      jsonResponse({
        web: {
          results: [
            {
              title: "Postgres <strong>RLS</strong>",
              url: "https://www.postgresql.org/docs/rls",
              description: "Row <strong>security</strong> policies &#39;per tenant&#39;",
              page_age: "2025-01-15T08:30:00",
            },
          ],
        },
      }),
    );
    const results = await createSearchPort({ braveKey: "br-secret" }, fetchFn)!.search(
      "postgres rls",
      opts(30),
    );
    const url = new URL(calls[0].url);
    expect(url.origin + url.pathname).toBe("https://api.search.brave.com/res/v1/web/search");
    expect(url.searchParams.get("q")).toBe("postgres rls");
    expect(url.searchParams.get("count")).toBe("20");
    expect(calls[0].headers["x-subscription-token"]).toBe("br-secret");
    expect(results[0].title).toBe("Postgres RLS");
    expect(results[0].snippet).toBe("Row security policies 'per tenant'");
    expect(results[0].published?.startsWith("2025-01-15")).toBe(true);
  });

  test("HTTP errors name the provider and status, never the key", async () => {
    const { fetchFn } = stubFetch(() => jsonResponse({ error: "bad token" }, 401));
    const port = createSearchPort({ braveKey: "br-secret" }, fetchFn)!;
    const err = await port.search("x", opts()).catch((e: Error) => e);
    expect(err).toBeInstanceOf(SearchProviderError);
    expect((err as Error).message).toContain("Brave search failed: HTTP 401");
    expect((err as Error).message).toContain("check the API key");
    expect((err as Error).message).not.toContain("br-secret");
  });
});

describe("searxng", () => {
  test("asks for JSON from the instance and maps its results", async () => {
    const { fetchFn, calls } = stubFetch(() =>
      jsonResponse({
        results: [
          {
            title: "SearXNG",
            url: "https://docs.searxng.org/",
            content: "A privacy-respecting <b>metasearch</b> engine",
            publishedDate: null,
          },
        ],
      }),
    );
    const port = createSearchPort({ searxngUrl: "http://search.lan:8888/" }, fetchFn)!;
    const results = await port.search("metasearch", opts());
    const url = new URL(calls[0].url);
    expect(url.origin + url.pathname).toBe("http://search.lan:8888/search");
    expect(url.searchParams.get("format")).toBe("json");
    expect(url.searchParams.get("q")).toBe("metasearch");
    expect(results).toEqual([
      {
        title: "SearXNG",
        url: "https://docs.searxng.org/",
        snippet: "A privacy-respecting metasearch engine",
      },
    ]);
  });

  test("403 explains that JSON output is disabled in settings.yml", async () => {
    const { fetchFn } = stubFetch(() => new Response("Forbidden", { status: 403 }));
    const port = createSearchPort({ searxngUrl: "https://sx.example" }, fetchFn)!;
    await expect(port.search("x", opts())).rejects.toThrow("settings.yml");
  });
});

describe("duckduckgo (keyless fallback)", () => {
  const PAGE = `
<div class="result results_links result--ad">
  <h2 class="result__title"><a rel="nofollow" class="result__a" href="https://duckduckgo.com/y.js?ad_domain=ads.example&amp;u3=x">Sponsored</a></h2>
  <a class="result__snippet" href="https://duckduckgo.com/y.js?ad_domain=ads.example">Buy now</a>
</div>
<div class="result results_links results_links_deep web-result">
  <h2 class="result__title">
    <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fa%3Fx%3D1%26y%3D2&amp;rut=abc">Example <b>Domain</b></a>
  </h2>
  <a class="result__url" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fa">example.com/a</a>
  <a class="result__snippet" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fa">This domain is for <b>illustrative</b> examples &amp; docs.</a>
</div>
<div class="result results_links web-result">
  <h2 class="result__title"><a class="result__a" href="https://direct.example.org/page">Direct link</a></h2>
  <div class="result__snippet">Second <b>snippet</b></div>
</div>`;

  test("parses titles and snippets, decodes uddg redirects and skips ads", () => {
    expect(parseDuckDuckGoHtml(PAGE)).toEqual([
      {
        title: "Example Domain",
        url: "https://example.com/a?x=1&y=2",
        snippet: "This domain is for illustrative examples & docs.",
      },
      { title: "Direct link", url: "https://direct.example.org/page", snippet: "Second snippet" },
    ]);
  });

  test("POSTs the query as a form and reports bot checks clearly", async () => {
    const { fetchFn, calls } = stubFetch(() => new Response(PAGE));
    const results = await createSearchPort({}, fetchFn)!.search("example domain", opts(1));
    expect(calls[0].url).toBe("https://html.duckduckgo.com/html/");
    expect(calls[0].method).toBe("POST");
    expect(calls[0].headers["content-type"]).toBe("application/x-www-form-urlencoded");
    expect(new URLSearchParams(calls[0].body).get("q")).toBe("example domain");
    expect(results.length).toBe(1);

    const blocked = stubFetch(() => new Response('<div class="anomaly-modal">are you human</div>'));
    await expect(createSearchPort({}, blocked.fetchFn)!.search("x", opts())).rejects.toThrow(
      "bot check",
    );
  });
});

describe("cancellation", () => {
  test("the caller's signal aborts an in-flight search", async () => {
    const fetchFn = ((_u: unknown, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted by signal")));
      })) as unknown as typeof fetch;
    const ac = new AbortController();
    const pending = createSearchPort({ tavilyKey: "k" }, fetchFn)!.search("x", {
      limit: 3,
      signal: ac.signal,
    });
    ac.abort();
    await expect(pending).rejects.toThrow("aborted");
  });
});

describe("websearch tool", () => {
  test("lists titles, dates, URLs and snippets from the host's search port", async () => {
    const search: SearchPort = {
      provider: "stub",
      search: async (_q, o) =>
        [
          {
            title: "One",
            url: "https://one.example",
            snippet: "first",
            published: "2026-01-02T00:00:00.000Z",
          },
          { title: "Two", url: "https://two.example", snippet: "second" },
        ].slice(0, o.limit),
    };
    const ctx = {
      signal: new AbortController().signal,
      services: { search },
    } as unknown as ToolContext;
    const out = await websearchTool.execute({ query: "things", limit: 5 }, ctx);
    expect(out.title).toBe("things · 2 results");
    expect(out.output).toContain("1. One (2026-01-02)\n   https://one.example\n   first");
    expect(out.output).toContain("2. Two\n   https://two.example\n   second");
    const none = await websearchTool.execute({ query: "x", limit: 5 }, {
      ...ctx,
      services: {},
    } as ToolContext);
    expect(none.output).toBe("Web search is not configured.");
  });
});
