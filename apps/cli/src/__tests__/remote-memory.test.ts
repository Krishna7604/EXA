import { describe, expect, test } from "bun:test";
import { ExaApi } from "../services/api.service.ts";
import { remoteMemory } from "../sync/remote-memory.ts";

const MEMORY = {
  id: "m1",
  topic: "diet",
  content: "vegetarian",
  sourceSessionId: null,
  time: { created: 1, updated: 1 },
};

/** Fake server: records each call; DELETE of "gone" is a 404, of "boom" a 500. */
function fakeServer() {
  const calls: Array<{ method: string; url: URL; body: unknown }> = [];
  const fetchFn = (async (url: string, init?: RequestInit) => {
    const u = new URL(url);
    const method = init?.method ?? "GET";
    calls.push({ method, url: u, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (method === "DELETE" && u.pathname.endsWith("/gone")) return apiError("not_found", 404);
    if (method === "DELETE" && u.pathname.endsWith("/boom")) return apiError("down", 500);
    if (method === "DELETE") return new Response(null, { status: 204 });
    if (method === "GET") return Response.json([MEMORY]);
    return Response.json(MEMORY, { status: method === "POST" ? 201 : 200 });
  }) as unknown as typeof fetch;
  return { port: remoteMemory(new ExaApi("http://srv", "exa_tok", fetchFn)), calls };
}

describe("remote memory port", () => {
  test("maps the MemoryPort onto the server's memory and search endpoints", async () => {
    const { port, calls } = fakeServer();
    expect(await port.list(60)).toEqual([MEMORY]);
    await port.search("eggs & toast", 8);
    await port.searchChats!("trip?", 5);
    await port.save({ topic: "diet", content: "vegan", sessionId: "local-session" });
    await port.save({ id: "m1", topic: "diet", content: "vegan" });
    const seen = calls.map((c) => `${c.method} ${c.url.pathname}${c.url.search}`);
    expect(seen).toEqual([
      "GET /v1/memories?limit=60",
      "GET /v1/memories?q=eggs+%26+toast&limit=8",
      "GET /v1/search?q=trip%3F&limit=5",
      "POST /v1/memories",
      "PUT /v1/memories/m1",
    ]);
    expect(calls[3].body).toEqual({ topic: "diet", content: "vegan" });
  });

  test("forget: 204 is true, 404 is false, other errors throw", async () => {
    const { port } = fakeServer();
    expect(await port.forget("m1")).toBe(true);
    expect(await port.forget("gone")).toBe(false);
    await expect(port.forget("boom")).rejects.toThrow("down");
  });
});

function apiError(message: string, status: number): Response {
  return Response.json({ error: { code: message, message } }, { status });
}
