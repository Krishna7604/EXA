// Router + keystore tests — pure, offline (no network, dummy keys only).
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { prefixOf } from "../providers.js";
import { resolveRoute, shouldRetry } from "../../router.js";
import { bedrockAuth, bedrockRegion, redact } from "../keystore.js";
import { bedrockEndpoint, buildConverseBody } from "../bedrock.js";

const AWS_KEYS = [
  "AWS_BEARER_TOKEN_BEDROCK",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "AWS_REGION",
  "BEDROCK_REGION",
];
const savedAws: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of AWS_KEYS) {
    savedAws[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  for (const k of AWS_KEYS) {
    if (savedAws[k] === undefined) delete process.env[k];
    else process.env[k] = savedAws[k];
  }
});

describe("prefixOf", () => {
  test("splits provider/model slugs", () => {
    expect(prefixOf("anthropic/claude-opus-latest")).toBe("anthropic");
    expect(prefixOf("openai/gpt-5")).toBe("openai");
  });
  test("bare model defaults to openrouter", () => {
    expect(prefixOf("gpt-5")).toBe("openrouter");
  });
});

describe("resolveRoute", () => {
  test("openrouter key serves any slug via aggregator", () => {
    process.env.OPENROUTER_API_KEY = "sk-or-test";
    delete process.env.ANTHROPIC_API_KEY;
    const r = resolveRoute("anthropic/claude-opus-latest");
    expect(r.provider).toBe("openrouter");
    expect(r.via).toBe("openrouter");
    delete process.env.OPENROUTER_API_KEY;
  });
  test("direct key wins under default strategy", () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    delete process.env.OPENROUTER_API_KEY;
    const r = resolveRoute("anthropic/claude-opus-latest");
    expect(r.provider).toBe("anthropic");
    expect(r.via).toBe("direct");
    expect(r.directModel).toBe("claude-opus-latest");
    delete process.env.ANTHROPIC_API_KEY;
  });
  test("missing keys throw with setup hint", () => {
    delete process.env.OPENROUTER_API_KEY;
    delete process.env.OPENAI_API_KEY;
    expect(() => resolveRoute("openai/gpt-5")).toThrow("missing API key");
  });
});

describe("shouldRetry", () => {
  test("retries 429/5xx only when no mutating tool ran", () => {
    expect(shouldRetry(429, false)).toBe(true);
    expect(shouldRetry(500, false)).toBe(true);
    expect(shouldRetry(429, true)).toBe(false);
    expect(shouldRetry(400, false)).toBe(false);
  });
});

describe("redact", () => {
  test("strips key values from logs", () => {
    process.env.OPENAI_API_KEY = "sk-secret-123";
    expect(redact("using sk-secret-123 now")).not.toContain("sk-secret-123");
    expect(redact("OPENAI_API_KEY=sk-secret-123")).toContain("***REDACTED***");
    delete process.env.OPENAI_API_KEY;
  });
});

describe("bedrock", () => {
  test("bearer token routes direct with default region", () => {
    process.env.AWS_BEARER_TOKEN_BEDROCK = "bedrock-test-token";
    expect(bedrockAuth()).toMatchObject({ kind: "bearer" });
    expect(bedrockRegion()).toBe("us-east-1");
    const r = resolveRoute("bedrock/us.anthropic.claude-sonnet-4-6");
    expect(r.provider).toBe("bedrock");
    expect(r.via).toBe("direct");
    expect(r.directModel).toBe("us.anthropic.claude-sonnet-4-6");
    expect(r.endpoint).toBe("https://bedrock-runtime.us-east-1.amazonaws.com");
    expect(r.region).toBe("us-east-1");
  });
  test("BEDROCK_REGION overrides AWS_REGION", () => {
    process.env.AWS_BEARER_TOKEN_BEDROCK = "bedrock-test-token";
    process.env.AWS_REGION = "eu-west-1";
    process.env.BEDROCK_REGION = "ap-south-1";
    expect(bedrockRegion()).toBe("ap-south-1");
    expect(bedrockEndpoint("ap-south-1")).toBe("https://bedrock-runtime.ap-south-1.amazonaws.com");
  });
  test("SigV4 pair works without bearer", () => {
    process.env.AWS_ACCESS_KEY_ID = "AKIA-TEST";
    process.env.AWS_SECRET_ACCESS_KEY = "secret-test";
    expect(bedrockAuth()).toMatchObject({ kind: "sigv4" });
    const r = resolveRoute("bedrock/anthropic.claude-haiku-4-5-20251001-v1:0");
    expect(r.provider).toBe("bedrock");
    expect(r.directModel).toBe("anthropic.claude-haiku-4-5-20251001-v1:0");
  });
  test("access key alone is not enough", () => {
    process.env.AWS_ACCESS_KEY_ID = "AKIA-TEST";
    expect(bedrockAuth()).toBeNull();
    expect(() => resolveRoute("bedrock/us.anthropic.claude-sonnet-4-6")).toThrow("Bedrock credentials");
  });
  test("converse body carries system + maxTokens", () => {
    const body = buildConverseBody("sys", [{ role: "user", text: "hi" }], 2048);
    expect(body.system).toEqual([{ text: "sys" }]);
    expect(body.inferenceConfig).toEqual({ maxTokens: 2048 });
    expect(body.messages).toEqual([{ role: "user", content: [{ text: "hi" }] }]);
  });
  test("redact strips bedrock secrets", () => {
    process.env.AWS_BEARER_TOKEN_BEDROCK = "bedrock-test-token";
    process.env.AWS_SECRET_ACCESS_KEY = "secret-test";
    const out = redact("token bedrock-test-token secret secret-test");
    expect(out).not.toContain("bedrock-test-token");
    expect(out).not.toContain("secret-test");
  });
});
