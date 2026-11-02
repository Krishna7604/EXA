// Class-level tests: ServiceContainer wiring with injected env.
// Never touches process.env or disk-backed session — all env is injected.
import { describe, expect, test } from "bun:test";
import { Agent } from "../agent.js";
import { ServiceContainer } from "../container.js";

describe("ServiceContainer", () => {
  test("wires the full graph from injected env", () => {
    const c = ServiceContainer.create({ OPENROUTER_API_KEY: "sk-or-test" } as NodeJS.ProcessEnv);
    expect(c.agent).toBeInstanceOf(Agent);
    expect(c.tools.list().map((t) => t.name).sort()).toEqual(["edit", "glob", "grep", "read", "shell", "write"]);
    expect(c.keystore.hasKey("openrouter")).toBe(true);
    expect(c.keystore.hasKey("bedrock")).toBe(false);
    expect(c.router.resolveRoute("openai/gpt-5-mini").provider).toBe("openrouter");
  });

  test("bedrock route uses the injected region", () => {
    const c = ServiceContainer.create({
      AWS_BEARER_TOKEN_BEDROCK: "tok",
      BEDROCK_REGION: "eu-north-1",
    } as NodeJS.ProcessEnv);
    const r = c.router.resolveRoute("bedrock/eu.amazon.nova-micro-v1:0");
    expect(r.region).toBe("eu-north-1");
    expect(r.endpoint).toBe("https://bedrock-runtime.eu-north-1.amazonaws.com");
  });

  test("empty env leaves no keys and router has no usable chain", () => {
    const c = ServiceContainer.create({} as NodeJS.ProcessEnv);
    expect(c.keystore.availableProviders()).toEqual([]);
    expect(() => c.router.routeChain("hi")).toThrow("no usable model");
  });

  test("does not mutate the real process.env", () => {
    const before = process.env.OPENROUTER_API_KEY;
    ServiceContainer.create({ OPENROUTER_API_KEY: "sk-or-test" } as NodeJS.ProcessEnv);
    expect(process.env.OPENROUTER_API_KEY).toBe(before);
  });
});
