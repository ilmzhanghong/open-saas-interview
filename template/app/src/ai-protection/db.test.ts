import { describe, expect, it, vi } from "vitest";
import { createProtectionDb } from "./db";

function makeFakeEntities(overrides: Record<string, unknown> = {}) {
  return {
    User: {
      findUnique: vi.fn(async () => ({
        id: "u1",
        credits: 3,
        subscriptionStatus: null,
      })),
      updateMany: vi.fn(async () => ({ count: 1 })),
      update: vi.fn(async () => ({})),
      ...(overrides.User ?? {}),
    },
    AIOperationLog: {
      create: vi.fn(async (args: unknown) => ({
        id: "claim-1",
        ...(args as { data?: Record<string, unknown> }).data,
      })),
      findFirst: vi.fn(async () => null),
      updateMany: vi.fn(async () => ({ count: 1 })),
      update: vi.fn(async () => ({})),
      ...(overrides.AIOperationLog ?? {}),
    },
  };
}

describe("createProtectionDb", () => {
  it("claims a dedupe slot on insert success", async () => {
    const entities = makeFakeEntities();
    const db = createProtectionDb(entities as never);
    const result = await db.claimDedupe({
      userId: "u1",
      operationType: "test-op",
      dedupeKey: "abc",
      dedupeWindow: 0n,
      inputText: "input",
    });
    expect(result).toEqual({ kind: "claimed", id: "claim-1" });
    expect(entities.AIOperationLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "in_progress" }),
      }),
    );
  });

  it("returns conflict with existing row on unique violation (P2002)", async () => {
    const existing = {
      id: "claim-0",
      status: "completed",
      outputText: "{}",
      createdAt: new Date(),
    };
    const entities = makeFakeEntities({
      AIOperationLog: {
        create: vi.fn(async () => {
          throw { code: "P2002" };
        }),
        findFirst: vi.fn(async () => existing),
      },
    });
    const db = createProtectionDb(entities as never);
    const result = await db.claimDedupe({
      userId: "u1",
      operationType: "test-op",
      dedupeKey: "abc",
      dedupeWindow: 0n,
      inputText: "input",
    });
    expect(result).toEqual({ kind: "conflict", existing });
  });

  it("rethrows non-unique-violation errors", async () => {
    const entities = makeFakeEntities({
      AIOperationLog: {
        create: vi.fn(async () => {
          throw new Error("boom");
        }),
      },
    });
    const db = createProtectionDb(entities as never);
    await expect(
      db.claimDedupe({
        userId: "u1",
        operationType: "test-op",
        dedupeKey: "abc",
        dedupeWindow: 0n,
        inputText: "input",
      }),
    ).rejects.toThrow("boom");
  });

  it("reserveCredits returns false when credits are insufficient", async () => {
    const entities = makeFakeEntities({
      User: {
        findUnique: vi.fn(async () => null),
        updateMany: vi.fn(async () => ({ count: 0 })),
        update: vi.fn(async () => ({})),
      },
    });
    const db = createProtectionDb(entities as never);
    expect(await db.reserveCredits("u1", 1)).toBe(false);
    expect(entities.User.updateMany).toHaveBeenCalledWith({
      where: { id: "u1", credits: { gte: 1 } },
      data: { credits: { decrement: 1 } },
    });
  });

  it("takeOverFailedClaim returns false when someone else took it", async () => {
    const entities = makeFakeEntities({
      AIOperationLog: {
        updateMany: vi.fn(async () => ({ count: 0 })),
      },
    });
    const db = createProtectionDb(entities as never);
    expect(await db.takeOverFailedClaim("claim-1")).toBe(false);
  });
});
