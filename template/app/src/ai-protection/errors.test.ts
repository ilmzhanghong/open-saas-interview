import { describe, expect, it } from "vitest";
import { ProtectionError } from "./errors";

describe("ProtectionError", () => {
  it("carries statusCode, message and retryAfterMs", () => {
    const err = new ProtectionError(429, "slow down", { retryAfterMs: 2500 });
    expect(err.statusCode).toBe(429);
    expect(err.message).toBe("slow down");
    expect(err.retryAfterMs).toBe(2500);
    expect(err).toBeInstanceOf(Error);
  });

  it("defaults data to empty object", () => {
    const err = new ProtectionError(402, "no credits");
    expect(err.data).toEqual({});
  });
});
