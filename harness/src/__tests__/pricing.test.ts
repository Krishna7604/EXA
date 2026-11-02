// Pricing tests — estimates only (see module header), math must be exact.
import { describe, expect, test } from "bun:test";
import { estimateTokens, formatCost, priceFor } from "../observability/pricing.js";

describe("pricing", () => {
  test("nova-micro family prices input + output per 1M tokens", () => {
    const cost = priceFor("eu.amazon.nova-micro-v1:0", { inputTokens: 1_000_000, outputTokens: 1_000_000 });
    expect(cost).toBeCloseTo(0.175, 9);
  });

  test("unknown families return null (tokens still shown)", () => {
    expect(priceFor("mystery/model-9", { inputTokens: 100, outputTokens: 50 })).toBeNull();
  });

  test("formatCost uses ~ prefix, em dash for unknown", () => {
    expect(formatCost(0.000056)).toBe("~$0.0001");
    expect(formatCost(null)).toBe("—");
    expect(formatCost(undefined)).toBe("—");
  });

  test("estimateTokens is chars/4, minimum 1", () => {
    expect(estimateTokens("12345678")).toBe(2);
    expect(estimateTokens("")).toBe(1);
  });
});
