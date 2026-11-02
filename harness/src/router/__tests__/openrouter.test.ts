// OpenRouter client tests — offline with stubbed fetch. No network.
import { describe, expect, test } from "bun:test";
import { Keystore } from "../keystore.js";
import { ProviderCatalog } from "../providers.js";
import { OpenRouterClient } from "../openrouter.js";

function envWith(key: string): Keystore {
  return new Keystore({ OPENROUTER_API_KEY: key } as NodeJS.ProcessEnv, new ProviderCatalog());
}

describe("OpenRouterClient", () => {
  test("listModels parses pricing + sorts", async () => {
    const c = new OpenRouterClient(envWith("sk-or-test"));
    const fakeFetch = (async () => ({
      ok: true,
      json: async () => ({
        data: [
          { id: "openai/gpt-5-mini", name: "GPT-5 mini", context_length: 400000, pricing: { prompt: "0.00000025", completion: "0.000002" } },
          { id: "google/gemini-2.5-flash", name: "Flash", context_length: 1000000, pricing: { prompt: "0.0000003", completion: "0.0000025" } },
        ],
      }),
      text: async () => "",
    })) as unknown as typeof fetch;
    const models = await c.listModels(fakeFetch);
    expect(models.map((m) => m.id)).toEqual(["google/gemini-2.5-flash", "openai/gpt-5-mini"]);
    expect(models[1].promptPerMtok).toBeCloseTo(0.25, 5);
    expect(models[1].completionPerMtok).toBeCloseTo(2, 5);
  });

  test("listModels throws with status on failure", async () => {
    const c = new OpenRouterClient(envWith("bad"));
    const fakeFetch = (async () => ({ ok: false, status: 401, text: async () => "unauthorized" })) as unknown as typeof fetch;
    const err = await c.chat("openai/gpt-5-mini", "", [], 10, fakeFetch).catch((e) => e) as Error & { status: number };
    expect(err.status).toBe(401);
  });

  test("chat builds OpenAI-compatible body + parses usage", async () => {
    const c = new OpenRouterClient(envWith("sk-or-test"));
    let seen: Record<string, unknown> = {};
    const fakeFetch = (async (_url: string, init: { body?: string }) => ({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: "hello from or" } }],
        usage: { prompt_tokens: 12, completion_tokens: 7 },
      }),
      text: async () => "",
    })) as unknown as typeof fetch;
    const wrapped = (async (url: string, init?: RequestInit) => {
      seen = JSON.parse(String((init?.body as string) ?? "{}"));
      return fakeFetch(url, init as { body?: string });
    }) as unknown as typeof fetch;
    const out = await c.chat("openai/gpt-5-mini", "sys", [{ role: "user", text: "hi" }], 32, wrapped);
    expect(out.text).toBe("hello from or");
    expect(out.usage).toEqual({ inputTokens: 12, outputTokens: 7 });
    expect(seen).toMatchObject({ model: "openai/gpt-5-mini", max_tokens: 32 });
  });

  test("missing key throws setup hint", async () => {
    const c = new OpenRouterClient(new Keystore({} as NodeJS.ProcessEnv, new ProviderCatalog()));
    await expect(c.chat("openai/gpt-5-mini", "", [{ role: "user", text: "hi" }], 10)).rejects.toThrow("OPENROUTER_API_KEY");
  });
});
