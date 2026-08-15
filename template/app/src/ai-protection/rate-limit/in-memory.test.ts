import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InMemoryRateLimitStore } from "./in-memory";

describe("InMemoryRateLimitStore", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("allows up to max requests in a window", async () => {
    const store = new InMemoryRateLimitStore();
    for (let i = 0; i < 3; i++) {
      expect(await store.consume("k", 1000, 3)).toEqual({ allowed: true });
    }
    expect((await store.consume("k", 1000, 3)).allowed).toBe(false);
  });

  it("returns a positive retryAfterMs when blocked", async () => {
    const store = new InMemoryRateLimitStore();
    for (let i = 0; i < 3; i++) await store.consume("k", 1000, 3);
    const res = await store.consume("k", 1000, 3);
    expect(res.allowed).toBe(false);
    expect(res.retryAfterMs).toBeGreaterThan(0);
    expect(res.retryAfterMs).toBeLessThanOrEqual(1000);
  });

  it("slides the window after it elapses", async () => {
    const store = new InMemoryRateLimitStore();
    for (let i = 0; i < 3; i++) await store.consume("k", 1000, 3);
    vi.advanceTimersByTime(1001);
    expect((await store.consume("k", 1000, 3)).allowed).toBe(true);
  });

  it("isolates keys", async () => {
    const store = new InMemoryRateLimitStore();
    for (let i = 0; i < 3; i++) await store.consume("a", 1000, 3);
    expect((await store.consume("b", 1000, 3)).allowed).toBe(true);
  });
});
