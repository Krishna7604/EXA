// Class-level tests: ProviderCatalog, Keystore (injected env), BedrockClient,
// ModelRouter (injected deps). Pure offline — dummy keys only, no network.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { ModelRouter } from "../../router.js";
import { BedrockClient } from "../bedrock.js";
import { Keystore } from "../keystore.js";
import { PROVIDERS, ProviderCatalog } from "../providers.js";

const savedAgentModel: string | undefined = process.env.AGENT_MODEL;

beforeEach(() => {
  delete process.env.AGENT_MODEL;
});

afterEach(() => {
  if (savedAgentModel === undefined) delete process.env.AGENT_MODEL;
  else process.env.AGENT_MODEL = savedAgentModel;
});

function fakeEnv(vars: Record<string, string>): NodeJS.ProcessEnv {
  return { ...vars } as NodeJS.ProcessEnv;
}

function makeRouter(envVars: Record<string, string>, cfgModel = "openai/gpt-5-mini"): { router: ModelRouter; keystore: Keystore } {
  const catalog = new ProviderCatalog();
  const keystore = new Keystore(fakeEnv(envVars), catalog);
  const bedrock = new BedrockClient(keystore);
  const router = new ModelRouter(catalog, keystore, bedrock, {
    model: cfgModel,
    fallbacks: [{ model: "openai/gpt-5" }],
    routing: { strategy: "direct-if-key-else-openrouter" },
  });
  return { router, keystore };
}

describe("ProviderCatalog", () => {
  test("lists all provider defs", () => {
    expect(new ProviderCatalog().list()).toEqual(PROVIDERS);
  });

  test("prefixOf splits slugs, bare models default to openrouter", () => {
    const c = new ProviderCatalog();
    expect(c.prefixOf("bedrock/eu.amazon.nova-micro-v1:0")).toBe("bedrock");
    expect(c.prefixOf("gpt-5")).toBe("openrouter");
  });

  test("directProviderFor maps known prefixes, null for unknown", () => {
    const c = new ProviderCatalog();
    expect(c.directProviderFor("bedrock")).toBe("bedrock");
    expect(c.directProviderFor("openai")).toBe("openai");
    expect(c.directProviderFor("nope")).toBeNull();
  });

  test("getProvider throws on unknown id", () => {
    expect(() => new ProviderCatalog().getProvider("nope" as never)).toThrow("unknown provider");
  });
});

describe("Keystore (injected env)", () => {
  test("reads keys from injected env, not process.env", () => {
    const ks = new Keystore(fakeEnv({ OPENROUTER_API_KEY: "sk-or-test" }));
    expect(ks.hasKey("openrouter")).toBe(true);
    expect(ks.hasKey("openai")).toBe(false);
    expect(ks.requireKey("openrouter")).toBe("sk-or-test");
  });

  test("requireKey throws with setup hint when missing", () => {
    const ks = new Keystore(fakeEnv({}));
    expect(() => ks.requireKey("openai")).toThrow("harness/.env");
  });

  test("bedrock bearer wins, SigV4 pair works, single key is not enough", () => {
    const bearer = new Keystore(fakeEnv({ AWS_BEARER_TOKEN_BEDROCK: "tok" }));
    expect(bearer.bedrockAuth()).toMatchObject({ kind: "bearer" });
    const sigv4 = new Keystore(fakeEnv({ AWS_ACCESS_KEY_ID: "AKIA", AWS_SECRET_ACCESS_KEY: "sec" }));
    expect(sigv4.bedrockAuth()).toMatchObject({ kind: "sigv4" });
    const half = new Keystore(fakeEnv({ AWS_ACCESS_KEY_ID: "AKIA" }));
    expect(half.bedrockAuth()).toBeNull();
    expect(half.hasKey("bedrock")).toBe(false);
  });

  test("bedrockRegion precedence: BEDROCK_REGION > AWS_REGION > default", () => {
    expect(new Keystore(fakeEnv({})).bedrockRegion()).toBe("us-east-1");
    expect(new Keystore(fakeEnv({ AWS_REGION: "eu-west-1" })).bedrockRegion()).toBe("eu-west-1");
    expect(new Keystore(fakeEnv({ AWS_REGION: "eu-west-1", BEDROCK_REGION: "ap-south-1" })).bedrockRegion()).toBe("ap-south-1");
  });

  test("redact strips injected values and KEY= fragments", () => {
    const ks = new Keystore(fakeEnv({ OPENAI_API_KEY: "sk-secret-123" }));
    expect(ks.redact("using sk-secret-123 now")).not.toContain("sk-secret-123");
    expect(ks.redact("OPENAI_API_KEY=sk-secret-123")).toContain("***REDACTED***");
  });

  test("keyStatus / availableProviders reflect injected env only", () => {
    const ks = new Keystore(fakeEnv({ OPENROUTER_API_KEY: "x" }));
    expect(ks.keyStatus().openrouter).toBe(true);
    expect(ks.keyStatus().openai).toBe(false);
    expect(ks.availableProviders()).toEqual(["openrouter"]);
  });
});

describe("BedrockClient", () => {
  test("endpoint is region-templated", () => {
    expect(new BedrockClient().endpoint("eu-north-1")).toBe("https://bedrock-runtime.eu-north-1.amazonaws.com");
  });

  test("buildConverseBody carries system + maxTokens, omits empty system", () => {
    const c = new BedrockClient();
    const withSys = c.buildConverseBody("sys", [{ role: "user", text: "hi" }], 2048);
    expect(withSys.system).toEqual([{ text: "sys" }]);
    expect(withSys.inferenceConfig).toEqual({ maxTokens: 2048 });
    expect(c.buildConverseBody("", [{ role: "user", text: "hi" }], 128).system).toBeUndefined();
  });

  test("converse throws setup hint when no creds (no network)", async () => {
    const c = new BedrockClient(new Keystore(fakeEnv({})));
    await expect(c.converse("m", "s", [{ role: "user", text: "hi" }], 8)).rejects.toThrow("Bedrock credentials");
  });
});

describe("ModelRouter (injected deps)", () => {
  test("bedrock slug resolves direct with injected region", () => {
    const { router } = makeRouter({ AWS_BEARER_TOKEN_BEDROCK: "tok", BEDROCK_REGION: "eu-north-1" });
    const r = router.resolveRoute("bedrock/eu.amazon.nova-micro-v1:0");
    expect(r.provider).toBe("bedrock");
    expect(r.via).toBe("direct");
    expect(r.region).toBe("eu-north-1");
    expect(r.directModel).toBe("eu.amazon.nova-micro-v1:0");
  });

  test("direct key wins under default strategy, else aggregator", () => {
    const direct = makeRouter({ ANTHROPIC_API_KEY: "a" }).router;
    expect(direct.resolveRoute("anthropic/claude-opus-latest").via).toBe("direct");
    const agg = makeRouter({ OPENROUTER_API_KEY: "o" }).router;
    const r = agg.resolveRoute("anthropic/claude-opus-latest");
    expect(r.provider).toBe("openrouter");
    expect(r.via).toBe("openrouter");
  });

  test("direct-only strategy requires the slug's own provider", () => {
    const catalog = new ProviderCatalog();
    const keystore = new Keystore(fakeEnv({ OPENROUTER_API_KEY: "o" }), catalog);
    const router = new ModelRouter(catalog, keystore, new BedrockClient(keystore), {
      model: "openai/gpt-5-mini",
      routing: { strategy: "direct-only" },
    });
    // slug with no direct provider at all -> aggregator is forbidden
    expect(() => router.resolveRoute("unknownprovider/some-model")).toThrow("no direct provider");
    // slug WITH a direct provider but no key -> key setup hint
    expect(() => router.resolveRoute("openai/gpt-5")).toThrow("missing API key");
  });

  test("routeChain filters to keyed models, pickModel honors AGENT_MODEL", () => {
    const { router } = makeRouter({ OPENROUTER_API_KEY: "o" });
    const chain = router.routeChain("hi");
    expect(chain.length).toBeGreaterThan(0);
    expect(chain.every((r) => r.provider === "openrouter")).toBe(true);
    process.env.AGENT_MODEL = "openai/gpt-5-mini";
    expect(router.pickModel("hi")).toBe("openai/gpt-5-mini");
    delete process.env.AGENT_MODEL;
  });

  test("routeChain throws when nothing is keyed", () => {
    const { router } = makeRouter({});
    expect(() => router.routeChain("hi")).toThrow("no usable model");
  });

  test("shouldRetry only 429/5xx without mutating tools; describeRoute leaks no secrets", () => {
    const { router } = makeRouter({ AWS_BEARER_TOKEN_BEDROCK: "super-secret-token", BEDROCK_REGION: "eu-north-1" });
    expect(router.shouldRetry(429, false)).toBe(true);
    expect(router.shouldRetry(503, false)).toBe(true);
    expect(router.shouldRetry(429, true)).toBe(false);
    expect(router.shouldRetry(400, false)).toBe(false);
    const desc = router.describeRoute(router.resolveRoute("bedrock/eu.amazon.nova-micro-v1:0"));
    expect(desc).not.toContain("super-secret-token");
    expect(desc).toContain("eu-north-1");
  });
});
