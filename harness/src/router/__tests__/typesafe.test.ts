import { describe, expect, test } from "bun:test";
import { JevClient } from "../typesafe.js";
import { Keystore } from "../keystore.js";

function keystore(): Keystore {
  return new Keystore({ OPENROUTER_API_KEY: "sk-or-test" } as NodeJS.ProcessEnv);
}

describe("JevClient", () => {
  test("decide posts to systemone and parses answers", async () => {
    let body = "";
    const fetchFn = (async (_url: unknown, init?: RequestInit) => {
      body = String(init?.body);
      return new Response(
        JSON.stringify({ model: "typesafe/jev-router", answers: { a: { type: "choice", choice: "heavy", confidence: 0.9 } }, usage: { cost: 0 } }),
        { status: 200 },
      );
    }) as typeof fetch;
    const jev = new JevClient(keystore());
    const r = await jev.decide("fix the bug", { a: { type: "choice", instructions: "?", criteria: { heavy: "x" } } }, fetchFn);
    expect(r.answers.a?.choice).toBe("heavy");
    expect(body).toContain("typesafe/jev-router");
    expect(body).toContain("jev-router");
  });

  test("decideSafe returns null on error, never throws", async () => {
    const fetchFn = (async () => new Response("nope", { status: 500 })) as unknown as typeof fetch;
    const jev = new JevClient(keystore());
    expect(await jev.decideSafe("s", {}, fetchFn)).toBeNull();
  });

  test("isAvailable reflects openrouter key presence", () => {
    expect(new JevClient(keystore()).isAvailable()).toBe(true);
    expect(new JevClient(new Keystore({} as NodeJS.ProcessEnv)).isAvailable()).toBe(false);
  });
});
