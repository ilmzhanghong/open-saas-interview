import type { PrismaClient } from "@prisma/client";

export interface DedupeRow {
  id: string;
  status: string;
  outputText: string | null;
  createdAt: Date;
}

export type DedupeClaimResult =
  | { kind: "claimed"; id: string }
  | { kind: "conflict"; existing: DedupeRow };

export interface ProtectionUser {
  id: string;
  credits: number;
  subscriptionStatus: string | null;
}

export interface ProtectionDb {
  findUser(userId: string): Promise<ProtectionUser | null>;
  claimDedupe(args: {
    userId: string;
    operationType: string;
    dedupeKey: string;
    dedupeWindow: bigint;
    inputText: string;
  }): Promise<DedupeClaimResult>;
  takeOverFailedClaim(id: string): Promise<boolean>;
  reserveCredits(userId: string, amount: number): Promise<boolean>;
  refundCredits(userId: string, amount: number): Promise<void>;
  markCompleted(
    id: string,
    args: { outputText: string; latencyMs: number },
  ): Promise<void>;
  markFailed(
    id: string,
    args: { errorMessage: string; latencyMs: number },
  ): Promise<void>;
}

type UserDelegate = Pick<
  PrismaClient["user"],
  "findUnique" | "updateMany" | "update"
>;
type LogDelegate = Pick<
  PrismaClient["aIOperationLog"],
  "create" | "findFirst" | "updateMany" | "update"
>;

function isUniqueViolation(e: unknown): boolean {
  return (
    typeof e === "object" &&
    e !== null &&
    (e as { code?: string }).code === "P2002"
  );
}

function toDedupeRow(row: {
  id: string;
  status: string;
  outputText: string | null;
  createdAt: Date;
}): DedupeRow {
  return {
    id: row.id,
    status: row.status,
    outputText: row.outputText,
    createdAt: row.createdAt,
  };
}

export function createProtectionDb(entities: {
  User: UserDelegate;
  AIOperationLog: LogDelegate;
}): ProtectionDb {
  return {
    async findUser(userId) {
      const user = await entities.User.findUnique({ where: { id: userId } });
      if (!user) return null;
      return {
        id: user.id,
        credits: user.credits,
        subscriptionStatus: user.subscriptionStatus,
      };
    },

    async claimDedupe(args) {
      try {
        const row = await entities.AIOperationLog.create({
          data: {
            userId: args.userId,
            operationType: args.operationType,
            dedupeKey: args.dedupeKey,
            dedupeWindow: args.dedupeWindow,
            inputText: args.inputText,
            status: "in_progress",
          },
        });
        return { kind: "claimed", id: row.id };
      } catch (e) {
        if (!isUniqueViolation(e)) throw e;
        const existing = await entities.AIOperationLog.findFirst({
          where: {
            userId: args.userId,
            operationType: args.operationType,
            dedupeKey: args.dedupeKey,
            dedupeWindow: args.dedupeWindow,
          },
        });
        if (!existing) throw e;
        return { kind: "conflict", existing: toDedupeRow(existing) };
      }
    },

    async takeOverFailedClaim(id) {
      const res = await entities.AIOperationLog.updateMany({
        where: { id, status: "failed" },
        data: { status: "in_progress" },
      });
      return res.count === 1;
    },

    async reserveCredits(userId, amount) {
      const res = await entities.User.updateMany({
        where: { id: userId, credits: { gte: amount } },
        data: { credits: { decrement: amount } },
      });
      return res.count === 1;
    },

    async refundCredits(userId, amount) {
      await entities.User.update({
        where: { id: userId },
        data: { credits: { increment: amount } },
      });
    },

    async markCompleted(id, args) {
      await entities.AIOperationLog.update({
        where: { id },
        data: {
          status: "completed",
          outputText: args.outputText,
          latencyMs: args.latencyMs,
        },
      });
    },

    async markFailed(id, args) {
      await entities.AIOperationLog.update({
        where: { id },
        data: {
          status: "failed",
          errorMessage: args.errorMessage,
          latencyMs: args.latencyMs,
        },
      });
    },
  };
}
