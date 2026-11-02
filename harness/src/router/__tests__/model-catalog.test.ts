// Model catalog + envfile unit tests — pure offline.
import { describe, expect, test } from "bun:test";
import { formatModelPrice, modelsFor } from "../model-catalog.js";
import { upsertEnvLine } from "../envfile.js";

describe("model-catalog", () => {
  test("modelsFor filters by provider, all returns everything", () => {
    expect(modelsFor("openrouter").every((m) => m.provider === "openrouter")).toBe(true);
    expect(modelsFor("openrouter").length).toBeGreaterThan(5);
    expect(modelsFor("bedrock").every((m) => m.provider === "bedrock")).toBe(true);
    expect(modelsFor("all").length).toBeGreaterThan(modelsFor("openrouter").length);
  });

  test("formatModelPrice renders per-1M pricing", () => {
    expect(formatModelPrice({ inputPerMtok: 0.25, outputPerMtok: 2 })).toBe("$0.25 in / $2 out per 1M");
    expect(formatModelPrice({ inputPerMtok: null, outputPerMtok: null })).toBe("pricing n/a");
  });
});

describe("envfile", () => {
  test("upsertEnvLine replaces existing, appends missing", () => {
    expect(upsertEnvLine("A=1\nOPENROUTER_API_KEY=\n", "OPENROUTER_API_KEY", "sk-x")).toBe("A=1\nOPENROUTER_API_KEY=sk-x\n");
    expect(upsertEnvLine("A=1\n", "B", "2")).toBe("A=1\nB=2\n");
    expect(upsertEnvLine("", "AGENT_MODEL", "openai/gpt-5-mini")).toBe("AGENT_MODEL=openai/gpt-5-mini\n");
  });
});
