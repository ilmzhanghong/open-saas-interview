import { SubscriptionStatus } from "../payment/plans";
import type { AiOperationConfig } from "./config";
import { DEFAULT_QUOTA_COST } from "./config";
import type { ProtectionDb } from "./db";
import { buildDedupeKey, computeDedupeWindow } from "./dedup";
import { ProtectionError } from "./errors";
import type { RateLimitStore } from "./rate-limit/types";

export interface ProtectDeps {
  db: ProtectionDb;
  rateLimiter: RateLimitStore;
}

function isSubscribed(user: { subscriptionStatus: string | null }): boolean {
  return (
    user.subscriptionStatus === SubscriptionStatus.Active ||
    user.subscriptionStatus === SubscriptionStatus.CancelAtPeriodEnd
  );
}

export async function protectAiOperation<TArgs, TResult>(
  config: AiOperationConfig<TArgs>,
  deps: ProtectDeps,
  userId: string,
  args: TArgs,
  execute: (args: TArgs) => Promise<TResult>,
): Promise<TResult> {
  const operationKey = `${userId}:${config.operationType}`;

  if (config.rateLimit) {
    const rl = await deps.rateLimiter.consume(
      operationKey,
      config.rateLimit.windowMs,
      config.rateLimit.max,
    );
    if (!rl.allowed) {
      throw new ProtectionError(429, "Rate limit exceeded, try again shortly", {
        retryAfterMs: rl.retryAfterMs,
      });
    }
  }

  const user = await deps.db.findUser(userId);
  if (!user) {
    throw new ProtectionError(401, "User not found");
  }

  const now = Date.now();
  let claimId: string | null = null;

  if (config.dedupeTtlMs) {
    const dedupeKey = buildDedupeKey(config.inputToDedupeKey(args));
    const dedupeWindow = computeDedupeWindow(now, config.dedupeTtlMs);
    const claim = await deps.db.claimDedupe({
      userId,
      operationType: config.operationType,
      dedupeKey,
      dedupeWindow,
      inputText: config.inputToLogText(args),
    });
    if (claim.kind === "conflict") {
      const existing = claim.existing;
      if (existing.status === "completed") {
        if (existing.outputText === null) {
          throw new ProtectionError(429, "Duplicate request in progress", {
            retryAfterMs: 1_000,
          });
        }
        return JSON.parse(existing.outputText) as TResult;
      }
      if (existing.status === "in_progress") {
        throw new ProtectionError(429, "Duplicate request in progress", {
          retryAfterMs: 1_000,
        });
      }
      const tookOver = await deps.db.takeOverFailedClaim(existing.id);
      if (!tookOver) {
        throw new ProtectionError(429, "Duplicate request in progress", {
          retryAfterMs: 1_000,
        });
      }
      claimId = existing.id;
    } else {
      claimId = claim.id;
    }
  }

  const quotaCost = config.quotaCost ?? DEFAULT_QUOTA_COST;
  let reserved = false;
  if (!isSubscribed(user) && quotaCost > 0) {
    reserved = await deps.db.reserveCredits(userId, quotaCost);
    if (!reserved) {
      if (claimId) {
        await deps.db.markFailed(claimId, {
          errorMessage: "Insufficient credits",
          latencyMs: Date.now() - now,
        });
      }
      throw new ProtectionError(
        402,
        "User has no subscription and is out of credits",
      );
    }
  }

  let result: TResult;
  try {
    result = await execute(args);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    if (reserved) {
      await deps.db.refundCredits(userId, quotaCost);
    }
    if (claimId) {
      await deps.db.markFailed(claimId, {
        errorMessage: message,
        latencyMs: Date.now() - now,
      });
    }
    throw new ProtectionError(502, "AI operation failed", {
      data: { cause: message },
    });
  }

  if (claimId) {
    await deps.db.markCompleted(claimId, {
      outputText: JSON.stringify(result),
      latencyMs: Date.now() - now,
    });
  }
  return result;
}
