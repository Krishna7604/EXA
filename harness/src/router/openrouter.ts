// OpenRouter client — aggregator live path (1 key covers 200+ models).
// OpenAI-compatible chat/completions + public model catalog with pricing.
// Errors carry `.status`; never include secrets. Types live in ./types.ts.
import { defaultKeystore, type Keystore } from "./keystore.js";
import type { ChatMsg, TokenUsage } from "./types.js";

export interface OpenRouterModel {
  id: string;
  name: string;
  promptPerMtok: number | null;
  completionPerMtok: number | null;
  context: number | null;
}

export class OpenRouterClient {
  constructor(private readonly keystore: Keystore = defaultKeystore) {}

  private key(): string {
    return this.keystore.requireKey("openrouter");
  }

  /** Live catalog — pricing is per-1M tokens straight from OpenRouter. */
  async listModels(fetchFn: typeof fetch = fetch): Promise<OpenRouterModel[]> {
    const res = await fetchFn("https://openrouter.ai/api/v1/models", {
      headers: { Authorization: `Bearer ${this.key()}` },
    });
    if (!res.ok) {
      const err = new Error(`openrouter models ${res.status}: ${(await res.text()).slice(0, 300)}`) as Error & { status: number };
      err.status = res.status;
      throw err;
    }
    const json = (await res.json()) as {
      data?: Array<{
        id?: string;
        name?: string;
        context_length?: number;
        pricing?: { prompt?: string; completion?: string };
      }>;
    };
    return (json.data ?? [])
      .filter((m) => typeof m.id === "string" && m.id.length > 0)
      .map((m) => ({
        id: m.id as string,
        name: typeof m.name === "string" && m.name ? m.name : (m.id as string),
        promptPerMtok: m.pricing?.prompt !== undefined ? Number(m.pricing.prompt) * 1_000_000 : null,
        completionPerMtok: m.pricing?.completion !== undefined ? Number(m.pricing.completion) * 1_000_000 : null,
        context: typeof m.context_length === "number" ? m.context_length : null,
      }))
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  async chat(
    model: string,
    system: string,
    messages: ChatMsg[],
    maxTokens: number,
    fetchFn: typeof fetch = fetch,
  ): Promise<{ text: string; ms: number; usage: TokenUsage }> {
    const started = Date.now();
    const key = this.key();
    const msgs: Array<{ role: string; content: string }> = [];
    if (system) msgs.push({ role: "system", content: system });
    for (const m of messages) msgs.push({ role: m.role === "assistant" ? "assistant" : "user", content: m.text });
    const res = await fetchFn("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${key}`,
        "HTTP-Referer": "https://github.com/exa-harness",
        "X-Title": "exa-harness",
      },
      body: JSON.stringify({ model, messages: msgs, max_tokens: maxTokens }),
    });
    if (!res.ok) {
      const err = new Error(`openrouter chat ${res.status}: ${(await res.text()).slice(0, 500)}`) as Error & { status: number };
      err.status = res.status;
      throw err;
    }
    const json = (await res.json()) as {
      choices?: Array<{ message?: { content?: string | Array<{ text?: string }> } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    const raw = json.choices?.[0]?.message?.content ?? "";
    const text = typeof raw === "string" ? raw : raw.map((b) => b.text ?? "").join("");
    return {
      text,
      ms: Date.now() - started,
      usage: {
        inputTokens: typeof json.usage?.prompt_tokens === "number" ? json.usage.prompt_tokens : 0,
        outputTokens: typeof json.usage?.completion_tokens === "number" ? json.usage.completion_tokens : 0,
      },
    };
  }
}

export const defaultOpenRouter = new OpenRouterClient();
