import { describe, expect, it } from "vitest";
import { buildDedupeKey, computeDedupeWindow, normalizeInput } from "./dedup";

describe("normalizeInput", () => {
  it("trims, collapses whitespace and lowercases", () => {
    expect(normalizeInput("  Plan  My   Day\n")).toBe("plan my day");
  });

  it("is idempotent", () => {
    const once = normalizeInput("  A   B  ");
    expect(normalizeInput(once)).toBe(once);
  });
});

describe("buildDedupeKey", () => {
  it("is deterministic for equal normalized inputs", () => {
    expect(buildDedupeKey("Plan  My  Day")).toBe(buildDedupeKey("plan my day"));
  });

  it("differs for different inputs", () => {
    expect(buildDedupeKey("plan a")).not.toBe(buildDedupeKey("plan b"));
  });

  it("is a 64-char hex sha256", () => {
    expect(buildDedupeKey("x")).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("computeDedupeWindow", () => {
  it("buckets deterministically within the TTL", () => {
    const ttl = 600_000;
    expect(computeDedupeWindow(0, ttl)).toBe(0n);
    expect(computeDedupeWindow(599_999, ttl)).toBe(0n);
    expect(computeDedupeWindow(600_000, ttl)).toBe(600_000n);
  });
});
