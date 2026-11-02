// TypeSafe Jev client — structured decisions (Noul/Choice/Score) via OpenRouter.
// Default model is the free `typesafe/jev-router`; falls back to failing soft
// (callers treat errors as "no opinion") so a missing/paid key never blocks chat.
import { defaultKeystore, type Keystore } from "./keystore.js";

export interface JevChoiceOption {
  type: "choice";
  instructions: string;
  criteria: Record<string, string | null>;
}
export interface JevNoulQuestion {
  type: "noul";
  instructions: string;
  criteria?: Record<string, string>;
}
export interface JevScoreQuestion {
  type: "score";
  instructions: string;
  criteria: string[];
}
export type JevQuestion = JevChoiceOption | JevNoulQuestion | JevScoreQuestion;

export interface JevAnswer {
  choice?: string;
  noul?: number;
  score?: number;
  confidence?: number;
  probabilities?: Record<string, number>;
}

export interface JevResult {
  answers: Record<string, JevAnswer>;
  model: string;
  costUsd: number | null;
}

export class JevClient {
  constructor(
    private readonly keystore: Keystore = defaultKeystore,
    private readonly model: string = "typesafe/jev-router",
  ) {}

  isAvailable(): boolean {
    return this.keystore.hasKey("openrouter");
  }

  /** One batched decision call. Throws on missing key / HTTP error / bad shape. */
  async decide(
    state: string,
    questions: Record<string, JevQuestion>,
    fetchFn: typeof fetch = fetch,
  ): Promise<JevResult> {
    const key = this.keystore.requireKey("openrouter");
    const res = await fetchFn("https://openrouter.ai/api/v1/systemone", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${key}`,
        "HTTP-Referer": "https://github.com/exa-harness",
        "X-Title": "exa-harness",
      },
      body: JSON.stringify({ model: this.model, state, questions }),
    });
    if (!res.ok) {
      const err = new Error(`jev ${res.status}: ${(await res.text()).slice(0, 300)}`) as Error & { status: number };
      err.status = res.status;
      throw err;
    }
    const json = (await res.json()) as {
      model?: string;
      answers?: Record<string, JevAnswer>;
      usage?: { cost?: number };
    };
    return {
      answers: json.answers ?? {},
      model: typeof json.model === "string" ? json.model : this.model,
      costUsd: typeof json.usage?.cost === "number" ? json.usage.cost : null,
    };
  }

  /** Fail-soft wrapper — returns null on any error (no key, network, quota). */
  async decideSafe(
    state: string,
    questions: Record<string, JevQuestion>,
    fetchFn: typeof fetch = fetch,
  ): Promise<JevResult | null> {
    try {
      return await this.decide(state, questions, fetchFn);
    } catch {
      return null;
    }
  }
}

export const defaultJev = new JevClient();
