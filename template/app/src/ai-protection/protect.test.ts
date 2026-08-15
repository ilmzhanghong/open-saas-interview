import { describe, expect, it, vi } from "vitest";
import { SubscriptionStatus } from "../payment/plans";
import type { AiOperationConfig } from "./config";
import type { DedupeClaimResult, ProtectionDb } from "./db";
import { protectAiOperation } from "./protect";
import type { RateLimitStore } from "./rate-limit/types";

function makeConfig(
  overrides: Partial<AiOperationConfig> = {},
): AiOperationConfig {
  return {
    operationType: "test-op",
    quotaCost: 1,
    rateLimit: { windowMs: 1000, max: 3 },
    dedupeTtlMs: 600_000,
    inputToDedupeKey: (a) => JSON.stringify(a),
    inputToLogText: (a) => JSON.stringify(a),
    ...overrides,
  };
}

function makeFakeDb(overrides: Partial<ProtectionDb> = {}): ProtectionDb {
  return {
    findUser: vi.fn(async () => ({
      id: "u1",
      credits: 3,
      subscriptionStatus: null,
    })),
    claimDedupe: vi.fn(
      async (): Promise<DedupeClaimResult> => ({
        kind: "claimed",
        id: "claim-1",
      }),
    ),
    takeOverFailedClaim: vi.fn(async () => true),
    reserveCredits: vi.fn(async () => true),
    refundCredits: vi.fn(async () => {}),
    markCompleted: vi.fn(async () => {}),
    markFailed: vi.fn(async () => {}),
    ...overrides,
  };
}

const allowAll: RateLimitStore = {
  consume: vi.fn(async () => ({ allowed: true })),
};

describe("protectAiOperation", () => {
  it("reserves credits, executes and marks completed", async () => {
    const db = makeFakeDb();
    const execute = vi.fn(async () => ({ ok: true }));
    const result = await protectAiOperation(
      makeConfig(),
      { db, rateLimiter: allowAll },
      "u1",
      { hours: 4 },
      execute,
    );
    expect(result).toEqual({ ok: true });
    expect(db.reserveCredits).toHaveBeenCalledWith("u1", 1);
    expect(db.markCompleted).toHaveBeenCalledWith(
      "claim-1",
      expect.objectContaining({ outputText: '{"ok":true}' }),
    );
    expect(db.refundCredits).not.toHaveBeenCalled();
  });

  it("skips quota for subscribed users", async () => {
    const db = makeFakeDb({
      findUser: vi.fn(async () => ({
        id: "u1",
        credits: 0,
        subscriptionStatus: SubscriptionStatus.Active,
      })),
    });
    const execute = vi.fn(async () => "ok");
    await protectAiOperation(
      makeConfig(),
      { db, rateLimiter: allowAll },
      "u1",
      {},
      execute,
    );
    expect(db.reserveCredits).not.toHaveBeenCalled();
    expect(execute).toHaveBeenCalledOnce();
  });

  it("throws 429 when rate limited and never executes", async () => {
    const db = makeFakeDb();
    const execute = vi.fn(async () => "ok");
    const rateLimiter: RateLimitStore = {
      consume: vi.fn(async () => ({ allowed: false, retryAfterMs: 500 })),
    };
    await expect(
      protectAiOperation(makeConfig(), { db, rateLimiter }, "u1", {}, execute),
    ).rejects.toMatchObject({ statusCode: 429, retryAfterMs: 500 });
    expect(execute).not.toHaveBeenCalled();
  });

  it("replays completed dedupe hits without executing or reserving", async () => {
    const db = makeFakeDb({
      claimDedupe: vi.fn(
        async (): Promise<DedupeClaimResult> => ({
          kind: "conflict",
          existing: {
            id: "claim-0",
            status: "completed",
            outputText: '{"schedule":"yesterday"}',
            createdAt: new Date(),
          },
        }),
      ),
    });
    const execute = vi.fn(async () => "never");
    const result = await protectAiOperation(
      makeConfig(),
      { db, rateLimiter: allowAll },
      "u1",
      {},
      execute,
    );
    expect(result).toEqual({ schedule: "yesterday" });
    expect(execute).not.toHaveBeenCalled();
    expect(db.reserveCredits).not.toHaveBeenCalled();
  });

  it("throws 429 when the dedupe claim is in progress", async () => {
    const db = makeFakeDb({
      claimDedupe: vi.fn(
        async (): Promise<DedupeClaimResult> => ({
          kind: "conflict",
          existing: {
            id: "claim-0",
            status: "in_progress",
            outputText: null,
            createdAt: new Date(),
          },
        }),
      ),
    });
    await expect(
      protectAiOperation(
        makeConfig(),
        { db, rateLimiter: allowAll },
        "u1",
        {},
        vi.fn(async () => "ok"),
      ),
    ).rejects.toMatchObject({ statusCode: 429 });
  });

  it("takes over failed claims and proceeds", async () => {
    const db = makeFakeDb({
      claimDedupe: vi.fn(
        async (): Promise<DedupeClaimResult> => ({
          kind: "conflict",
          existing: {
            id: "claim-0",
            status: "failed",
            outputText: null,
            createdAt: new Date(),
          },
        }),
      ),
    });
    const execute = vi.fn(async () => "ok");
    const result = await protectAiOperation(
      makeConfig(),
      { db, rateLimiter: allowAll },
      "u1",
      {},
      execute,
    );
    expect(db.takeOverFailedClaim).toHaveBeenCalledWith("claim-0");
    expect(db.markCompleted).toHaveBeenCalledWith("claim-0", expect.anything());
    expect(result).toBe("ok");
  });

  it("throws 429 when the failed-claim takeover races", async () => {
    const db = makeFakeDb({
      claimDedupe: vi.fn(
        async (): Promise<DedupeClaimResult> => ({
          kind: "conflict",
          existing: {
            id: "claim-0",
            status: "failed",
            outputText: null,
            createdAt: new Date(),
          },
        }),
      ),
      takeOverFailedClaim: vi.fn(async () => false),
    });
    await expect(
      protectAiOperation(
        makeConfig(),
        { db, rateLimiter: allowAll },
        "u1",
        {},
        vi.fn(async () => "ok"),
      ),
    ).rejects.toMatchObject({ statusCode: 429 });
  });

  it("throws 402 and marks the claim failed when credits run out", async () => {
    const db = makeFakeDb({ reserveCredits: vi.fn(async () => false) });
    const execute = vi.fn(async () => "ok");
    await expect(
      protectAiOperation(
        makeConfig(),
        { db, rateLimiter: allowAll },
        "u1",
        {},
        execute,
      ),
    ).rejects.toMatchObject({ statusCode: 402 });
    expect(db.markFailed).toHaveBeenCalledWith(
      "claim-1",
      expect.objectContaining({ errorMessage: "Insufficient credits" }),
    );
    expect(execute).not.toHaveBeenCalled();
  });

  it("refunds credits and marks failed when execute throws, then throws 502", async () => {
    const db = makeFakeDb();
    const execute = vi.fn(async () => {
      throw new Error("openai down");
    });
    await expect(
      protectAiOperation(
        makeConfig(),
        { db, rateLimiter: allowAll },
        "u1",
        {},
        execute,
      ),
    ).rejects.toMatchObject({ statusCode: 502 });
    expect(db.refundCredits).toHaveBeenCalledWith("u1", 1);
    expect(db.markFailed).toHaveBeenCalledWith(
      "claim-1",
      expect.objectContaining({ errorMessage: "openai down" }),
    );
  });

  it("throws 401 without claiming when the user is missing", async () => {
    const db = makeFakeDb({ findUser: vi.fn(async () => null) });
    await expect(
      protectAiOperation(
        makeConfig(),
        { db, rateLimiter: allowAll },
        "u1",
        {},
        vi.fn(async () => "ok"),
      ),
    ).rejects.toMatchObject({ statusCode: 401 });
    expect(db.claimDedupe).not.toHaveBeenCalled();
  });

  it("skips reservation when quotaCost is 0", async () => {
    const db = makeFakeDb();
    const execute = vi.fn(async () => "ok");
    await protectAiOperation(
      makeConfig({ quotaCost: 0 }),
      { db, rateLimiter: allowAll },
      "u1",
      {},
      execute,
    );
    expect(db.reserveCredits).not.toHaveBeenCalled();
  });
});
