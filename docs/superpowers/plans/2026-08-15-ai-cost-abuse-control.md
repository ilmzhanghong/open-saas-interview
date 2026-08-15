# AI 成本与滥用控制 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 Open SaaS 的 AI 操作（generateGptResponse）加上可复用的保护层：额度预留-提交/回滚、可插拔限流（内存/DB）、基于 DB 唯一约束的 claim-based 去重、全量调用日志。

**Architecture:** 核心逻辑（`src/ai-protection/`）为纯 TS 模块，零 Wasp 依赖，可独立单测；`ProtectionDb` 与 `RateLimitStore` 接口注入，Wasp 胶水只出现在 `operations.ts` 与 `createProtectionDb`。去重采用「先占后调」：INSERT 日志行（status=in_progress）的 DB 唯一约束即并发仲裁者。所有保护错误经 `ProtectionError` 抛出，由 action 边界映射为 `HttpError`。

**Tech Stack:** Wasp 0.25（React/Node/Prisma 5）、TypeScript strict、vitest、node:crypto、zod。

**Spec:** `docs/superpowers/specs/2026-08-15-ai-cost-abuse-control-design.md`

---

## 环境前置（本机已验证）

- Node 24.14.1（nvm 默认已切；若 shell 仍解析旧版本，命令前加 `export PATH="/Users/Kevin/.nvm/versions/node/v24.14.1/bin:$PATH"`）
- Wasp CLI 0.25.0；`template/app` 内执行所有 wasp 命令
- Postgres 容器 `wasp-dev-db-OpenSaaS-565a25e677` 运行中（`wasp start db`）
- `wasp start` 正在后台运行（任务 b3hwf2y2l），会热重载源码
- 迁移命令必须带名字：`wasp db migrate-dev --name "xxx"`（否则卡交互输入）

---

### Task 1: 数据模型与迁移

**Files:**
- Modify: `template/app/schema.prisma`（追加两个 model）
- Modify: `template/app/src/demo-ai-app/demo-ai-app.wasp.ts`（entities 声明）

- [ ] **Step 1: 在 schema.prisma 末尾追加两个 model**

```prisma
model AIOperationLog {
  id            String   @id @default(uuid())
  createdAt     DateTime @default(now())
  userId        String
  operationType String
  dedupeKey     String // sha256(normalizedInput)
  dedupeWindow  BigInt // TTL 桶起点：floor(nowMs / ttlMs) * ttlMs
  inputText     String
  outputText    String?
  status        String // "in_progress" | "completed" | "failed"
  tokensUsed    Int?
  costEstimate  Float?
  errorMessage  String?
  latencyMs     Int?

  @@unique([userId, operationType, dedupeKey, dedupeWindow])
  @@index([userId, createdAt])
}

model RateLimitCounter {
  id          Int    @id @default(autoincrement())
  key         String // `${userId}:${operationType}`
  windowStart BigInt // 固定窗口起点（ms）
  count       Int

  @@unique([key, windowStart])
}
```

- [ ] **Step 2: 生成迁移并应用**

Run: `cd template/app && export PATH="/Users/Kevin/.nvm/versions/node/v24.14.1/bin:$PATH" && wasp db migrate-dev --name "ai-protection"`

Expected: `migrations/2026XXXXXXXXXX_ai-protection/` 创建并应用成功；`wasp db migrate-dev` 输出 "Your database is now in sync with your schema."

- [ ] **Step 3: 更新 demo-ai-app.wasp.ts 的 entities 声明**

在 `template/app/src/demo-ai-app/demo-ai-app.wasp.ts` 中：

```ts
action(generateGptResponse, {
  entities: ["User", "Task", "GptResponse", "AIOperationLog", "RateLimitCounter"],
}),
```

（等 wasp start 热重载完成后，Step 4 用 tsc 验证类型可用）

- [ ] **Step 4: 验证生成类型可用**

Run: `cd template/app && node -e "import('@prisma/client').then(m => console.log('prisma client ok'))"`

Expected: `prisma client ok`（generated client 含新表；若报错，重启 `wasp start` 让 prisma generate 重新执行）

- [ ] **Step 5: Commit**

```bash
git add template/app/schema.prisma template/app/src/demo-ai-app/demo-ai-app.wasp.ts
git commit -m "feat: add AIOperationLog and RateLimitCounter models"
```

---

### Task 2: vitest 配置 + dedup 模块（TDD）

**Files:**
- Create: `template/app/vitest.config.ts`
- Modify: `template/app/package.json`（scripts.test）
- Create: `template/app/src/ai-protection/dedup.ts`
- Test: `template/app/src/ai-protection/dedup.test.ts`

- [ ] **Step 1: 加 vitest 配置与 test 脚本**

`template/app/vitest.config.ts`：

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
  },
});
```

`template/app/package.json` scripts 追加：

```json
"test": "vitest run"
```

- [ ] **Step 2: 写失败的 dedup 测试**

`template/app/src/ai-protection/dedup.test.ts`：

```ts
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
```

- [ ] **Step 3: 运行测试确认失败**

Run: `cd template/app && export PATH="/Users/Kevin/.nvm/versions/node/v24.14.1/bin:$PATH" && npm test`

Expected: FAIL（`Cannot find module './dedup'`）

- [ ] **Step 4: 实现 dedup.ts**

`template/app/src/ai-protection/dedup.ts`：

```ts
import { createHash } from "node:crypto";

export function normalizeInput(input: string): string {
  return input.trim().replace(/\s+/g, " ").toLowerCase();
}

export function buildDedupeKey(input: string): string {
  return createHash("sha256").update(normalizeInput(input)).digest("hex");
}

export function computeDedupeWindow(nowMs: number, ttlMs: number): bigint {
  return BigInt(Math.floor(nowMs / ttlMs) * ttlMs);
}
```

- [ ] **Step 5: 运行测试确认通过**

Run: `cd template/app && export PATH="/Users/Kevin/.nvm/versions/node/v24.14.1/bin:$PATH" && npm test`

Expected: 全部 PASS

- [ ] **Step 6: Commit**

```bash
git add template/app/vitest.config.ts template/app/package.json template/app/src/ai-protection/dedup.ts template/app/src/ai-protection/dedup.test.ts
git commit -m "feat: add dedupe key and TTL window helpers"
```

---

### Task 3: 保护错误与配置（TDD）

**Files:**
- Create: `template/app/src/ai-protection/errors.ts`
- Create: `template/app/src/ai-protection/config.ts`
- Test: `template/app/src/ai-protection/errors.test.ts`

- [ ] **Step 1: 写失败的测试**

`template/app/src/ai-protection/errors.test.ts`：

```ts
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
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd template/app && export PATH="/Users/Kevin/.nvm/versions/node/v24.14.1/bin:$PATH" && npm test`

Expected: FAIL（`Cannot find module './errors'`）

- [ ] **Step 3: 实现 errors.ts 与 config.ts**

`template/app/src/ai-protection/errors.ts`：

```ts
export class ProtectionError extends Error {
  readonly statusCode: number;
  readonly retryAfterMs?: number;
  readonly data: Record<string, unknown>;

  constructor(
    statusCode: number,
    message: string,
    opts: { retryAfterMs?: number; data?: Record<string, unknown> } = {},
  ) {
    super(message);
    this.name = "ProtectionError";
    this.statusCode = statusCode;
    this.retryAfterMs = opts.retryAfterMs;
    this.data = opts.data ?? {};
  }
}
```

`template/app/src/ai-protection/config.ts`：

```ts
export interface RateLimitConfig {
  windowMs: number;
  max: number;
}

export interface AiOperationConfig<TArgs = unknown> {
  operationType: string;
  quotaCost?: number;
  rateLimit?: RateLimitConfig;
  dedupeTtlMs?: number;
  inputToDedupeKey: (args: TArgs) => string;
  inputToLogText: (args: TArgs) => string;
}

export const DEFAULT_QUOTA_COST = 1;
export const DEFAULT_DEDUPE_TTL_MS = 600_000;
export const DEFAULT_RATE_LIMIT: RateLimitConfig = { windowMs: 60_000, max: 10 };
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd template/app && export PATH="/Users/Kevin/.nvm/versions/node/v24.14.1/bin:$PATH" && npm test`

Expected: 全部 PASS

- [ ] **Step 5: Commit**

```bash
git add template/app/src/ai-protection/errors.ts template/app/src/ai-protection/config.ts template/app/src/ai-protection/errors.test.ts
git commit -m "feat: add protection error and per-operation config"
```

---

### Task 4: 内存限流器（TDD）

**Files:**
- Create: `template/app/src/ai-protection/rate-limit/types.ts`
- Create: `template/app/src/ai-protection/rate-limit/in-memory.ts`
- Test: `template/app/src/ai-protection/rate-limit/in-memory.test.ts`

- [ ] **Step 1: 写失败的测试**

`template/app/src/ai-protection/rate-limit/in-memory.test.ts`：

```ts
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
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd template/app && export PATH="/Users/Kevin/.nvm/versions/node/v24.14.1/bin:$PATH" && npm test`

Expected: FAIL（`Cannot find module './in-memory'`）

- [ ] **Step 3: 实现 types.ts 与 in-memory.ts**

`template/app/src/ai-protection/rate-limit/types.ts`：

```ts
export interface RateLimitConsumeResult {
  allowed: boolean;
  retryAfterMs?: number;
}

export interface RateLimitStore {
  consume(
    key: string,
    windowMs: number,
    max: number,
  ): Promise<RateLimitConsumeResult>;
}

export type RateLimitStoreKind = "memory" | "db";
```

`template/app/src/ai-protection/rate-limit/in-memory.ts`：

```ts
import type { RateLimitConsumeResult, RateLimitStore } from "./types";

export class InMemoryRateLimitStore implements RateLimitStore {
  private hits = new Map<string, number[]>();

  async consume(
    key: string,
    windowMs: number,
    max: number,
  ): Promise<RateLimitConsumeResult> {
    const now = Date.now();
    const window = (this.hits.get(key) ?? []).filter(
      (t) => now - t < windowMs,
    );
    if (window.length >= max) {
      this.hits.set(key, window);
      return { allowed: false, retryAfterMs: windowMs - (now - window[0]) };
    }
    window.push(now);
    this.hits.set(key, window);
    return { allowed: true };
  }
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd template/app && export PATH="/Users/Kevin/.nvm/versions/node/v24.14.1/bin:$PATH" && npm test`

Expected: 全部 PASS

- [ ] **Step 5: Commit**

```bash
git add template/app/src/ai-protection/rate-limit/types.ts template/app/src/ai-protection/rate-limit/in-memory.ts template/app/src/ai-protection/rate-limit/in-memory.test.ts
git commit -m "feat: add in-memory sliding window rate limiter"
```

---

### Task 5: DB 限流器（TDD）

**Files:**
- Create: `template/app/src/ai-protection/rate-limit/db.ts`
- Create: `template/app/src/ai-protection/rate-limit/index.ts`
- Test: `template/app/src/ai-protection/rate-limit/db.test.ts`

- [ ] **Step 1: 写失败的测试**

`template/app/src/ai-protection/rate-limit/db.test.ts`：

```ts
import { describe, expect, it, vi } from "vitest";
import { DbRateLimitStore } from "./db";
import type { RateLimitCounterModel } from "./db";

function makeFakeCounter(initial = 0) {
  let count = initial;
  const upsert = vi.fn(async () => ({ count: ++count }));
  const counter: RateLimitCounterModel = { upsert };
  return { counter, upsert, getCount: () => count };
}

describe("DbRateLimitStore", () => {
  it("allows requests within the limit", async () => {
    const { counter } = makeFakeCounter();
    const store = new DbRateLimitStore(counter);
    for (let i = 0; i < 3; i++) {
      expect((await store.consume("k", 1000, 3)).allowed).toBe(true);
    }
  });

  it("blocks requests over the limit with retryAfterMs", async () => {
    const { counter } = makeFakeCounter(3);
    const store = new DbRateLimitStore(counter);
    const res = await store.consume("k", 1000, 3);
    expect(res.allowed).toBe(false);
    expect(res.retryAfterMs).toBeGreaterThan(0);
  });

  it("upserts with key and deterministic windowStart", async () => {
    vi.useFakeTimers();
    try {
      const { counter, upsert } = makeFakeCounter();
      const store = new DbRateLimitStore(counter);
      await store.consume("k", 1000, 3);
      const args = upsert.mock.calls[0][0];
      expect(args.where.key_windowStart.key).toBe("k");
      expect(args.where.key_windowStart.windowStart).toBe(0n);
      expect(args.update).toEqual({ count: { increment: 1 } });
      expect(args.create.count).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd template/app && export PATH="/Users/Kevin/.nvm/versions/node/v24.14.1/bin:$PATH" && npm test`

Expected: FAIL（`Cannot find module './db'`）

- [ ] **Step 3: 实现 db.ts 与 index.ts**

`template/app/src/ai-protection/rate-limit/db.ts`：

```ts
import type { RateLimitConsumeResult, RateLimitStore } from "./types";

export interface RateLimitCounterModel {
  upsert(args: {
    where: { key_windowStart: { key: string; windowStart: bigint } };
    update: { count: { increment: number } };
    create: { key: string; windowStart: bigint; count: number };
  }): Promise<{ count: number }>;
}

export class DbRateLimitStore implements RateLimitStore {
  constructor(private readonly counter: RateLimitCounterModel) {}

  async consume(
    key: string,
    windowMs: number,
    max: number,
  ): Promise<RateLimitConsumeResult> {
    const now = Date.now();
    const windowStart = BigInt(Math.floor(now / windowMs) * windowMs);
    const row = await this.counter.upsert({
      where: { key_windowStart: { key, windowStart } },
      update: { count: { increment: 1 } },
      create: { key, windowStart, count: 1 },
    });
    if (row.count > max) {
      return {
        allowed: false,
        retryAfterMs: Number(windowStart + BigInt(windowMs) - BigInt(now)),
      };
    }
    return { allowed: true };
  }
}
```

`template/app/src/ai-protection/rate-limit/index.ts`：

```ts
import { DbRateLimitStore } from "./db";
import { InMemoryRateLimitStore } from "./in-memory";
import type { RateLimitStore, RateLimitStoreKind } from "./types";

export function createRateLimitStore(
  kind: RateLimitStoreKind,
  counter: RateLimitCounterModel,
): RateLimitStore {
  return kind === "db"
    ? new DbRateLimitStore(counter)
    : new InMemoryRateLimitStore();
}
```

注意：`createRateLimitStore` 第二参的类型为 `RateLimitCounterModel`（在 `db.ts` 导出）。`operations.ts` 集成时传 `prisma.rateLimitCounter`（结构兼容）。

- [ ] **Step 4: 运行测试确认通过**

Run: `cd template/app && export PATH="/Users/Kevin/.nvm/versions/node/v24.14.1/bin:$PATH" && npm test`

Expected: 全部 PASS

- [ ] **Step 5: Commit**

```bash
git add template/app/src/ai-protection/rate-limit/db.ts template/app/src/ai-protection/rate-limit/db.test.ts template/app/src/ai-protection/rate-limit/index.ts
git commit -m "feat: add db-backed fixed-window rate limiter"
```

---

### Task 6: ProtectionDb 门面（TDD）

**Files:**
- Create: `template/app/src/ai-protection/db.ts`
- Test: `template/app/src/ai-protection/db.test.ts`

- [ ] **Step 1: 写失败的测试**

`template/app/src/ai-protection/db.test.ts`：

```ts
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
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd template/app && export PATH="/Users/Kevin/.nvm/versions/node/v24.14.1/bin:$PATH" && npm test`

Expected: FAIL（`Cannot find module './db'`）

- [ ] **Step 3: 实现 db.ts**

`template/app/src/ai-protection/db.ts`：

```ts
import type { PrismaClient } from "@prisma/client";
import type { User } from "wasp/entities";

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
    typeof e === "object" && e !== null && (e as { code?: string }).code === "P2002"
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
```

说明：`import type { User } from "wasp/entities"` 为纯类型导入（运行时擦除），测试与 Wasp 编译均不受影响；`User` 类型此处仅作文档用途（可删，保留以提示契约）。

- [ ] **Step 4: 运行测试确认通过**

Run: `cd template/app && export PATH="/Users/Kevin/.nvm/versions/node/v24.14.1/bin:$PATH" && npm test`

Expected: 全部 PASS

- [ ] **Step 5: Commit**

```bash
git add template/app/src/ai-protection/db.ts template/app/src/ai-protection/db.test.ts
git commit -m "feat: add ProtectionDb facade with claim/reserve/refund operations"
```

---

### Task 7: protectAiOperation 编排器（TDD）

**Files:**
- Create: `template/app/src/ai-protection/protect.ts`
- Test: `template/app/src/ai-protection/protect.test.ts`

- [ ] **Step 1: 写失败的测试**

`template/app/src/ai-protection/protect.test.ts`：

```ts
import { describe, expect, it, vi } from "vitest";
import { SubscriptionStatus } from "../payment/plans";
import type { AiOperationConfig } from "./config";
import type { DedupeClaimResult, ProtectionDb } from "./db";
import { ProtectionError } from "./errors";
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
      async (): Promise<DedupeClaimResult> => ({ kind: "claimed", id: "claim-1" }),
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
      protectAiOperation(
        makeConfig(),
        { db, rateLimiter },
        "u1",
        {},
        execute,
      ),
    ).rejects.toMatchObject({ statusCode: 429, retryAfterMs: 500 });
    expect(execute).not.toHaveBeenCalled();
  });

  it("replays completed dedupe hits without executing or reserving", async () => {
    const db = makeFakeDb({
      claimDedupe: vi.fn(async (): Promise<DedupeClaimResult> => ({
        kind: "conflict",
        existing: {
          id: "claim-0",
          status: "completed",
          outputText: '{"schedule":"yesterday"}',
          createdAt: new Date(),
        },
      })),
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
      claimDedupe: vi.fn(async (): Promise<DedupeClaimResult> => ({
        kind: "conflict",
        existing: {
          id: "claim-0",
          status: "in_progress",
          outputText: null,
          createdAt: new Date(),
        },
      })),
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
      claimDedupe: vi.fn(async (): Promise<DedupeClaimResult> => ({
        kind: "conflict",
        existing: {
          id: "claim-0",
          status: "failed",
          outputText: null,
          createdAt: new Date(),
        },
      })),
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
    expect(db.markCompleted).toHaveBeenCalledWith(
      "claim-0",
      expect.anything(),
    );
    expect(result).toBe("ok");
  });

  it("throws 429 when the failed-claim takeover races", async () => {
    const db = makeFakeDb({
      claimDedupe: vi.fn(async (): Promise<DedupeClaimResult> => ({
        kind: "conflict",
        existing: {
          id: "claim-0",
          status: "failed",
          outputText: null,
          createdAt: new Date(),
        },
      })),
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
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd template/app && export PATH="/Users/Kevin/.nvm/versions/node/v24.14.1/bin:$PATH" && npm test`

Expected: FAIL（`Cannot find module './protect'`）

- [ ] **Step 3: 实现 protect.ts**

`template/app/src/ai-protection/protect.ts`：

```ts
import { SubscriptionStatus } from "../payment/plans";
import { DEFAULT_QUOTA_COST } from "./config";
import type { AiOperationConfig } from "./config";
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
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd template/app && export PATH="/Users/Kevin/.nvm/versions/node/v24.14.1/bin:$PATH" && npm test`

Expected: 全部 PASS

- [ ] **Step 5: Commit**

```bash
git add template/app/src/ai-protection/protect.ts template/app/src/ai-protection/protect.test.ts
git commit -m "feat: add protectAiOperation orchestrator"
```

---

### Task 8: Wasp 集成（env / entities / operations）

**Files:**
- Create: `template/app/src/ai-protection/env.ts`
- Modify: `template/app/src/env.ts`（merge aiProtectionEnvSchema）
- Modify: `template/app/src/demo-ai-app/operations.ts`（重写 generateGptResponse）

- [ ] **Step 1: 新增 RATE_LIMIT_STORE 环境变量 schema**

`template/app/src/ai-protection/env.ts`：

```ts
import * as z from "zod";

export const aiProtectionEnvSchema = z.object({
  RATE_LIMIT_STORE: z.enum(["memory", "db"]).default("memory"),
});
```

`template/app/src/env.ts` 修改（追加 import 与 spread）：

```ts
import { aiProtectionEnvSchema } from "./ai-protection/env";
// 在 serverEnvValidationSchema 的 z.object({...}) 中追加：
...aiProtectionEnvSchema.shape,
```

- [ ] **Step 2: 重写 generateGptResponse**

`template/app/src/demo-ai-app/operations.ts` 变更：

1. 删除 `import type { PrismaPromise } from "@prisma/client";` 与 `import type { User } from "wasp/entities";`（不再使用）
2. 新增 imports：

```ts
import { createProtectionDb } from "../ai-protection/db";
import { ProtectionError } from "../ai-protection/errors";
import { createRateLimitStore } from "../ai-protection/rate-limit";
import { protectAiOperation } from "../ai-protection/protect";
```

3. `const openAi = ...` 之后新增：

```ts
const rateLimiter = createRateLimitStore(env.RATE_LIMIT_STORE, prisma.rateLimitCounter);
```

4. 将 `generateGptResponse` 函数体整体替换为：

```ts
export const generateGptResponse: GenerateGptResponse<
  GenerateGptResponseInput,
  GeneratedSchedule
> = async (rawArgs, context) => {
  if (!context.user) {
    throw new HttpError(
      401,
      "Only authenticated users are allowed to perform this operation",
    );
  }

  const { hours } = ensureArgsSchemaOrThrowHttpError(
    generateGptResponseInputSchema,
    rawArgs,
  );
  const tasks = await context.entities.Task.findMany({
    where: {
      user: {
        id: context.user.id,
      },
    },
  });

  // Deterministic serialization: stable order so identical requests
  // produce identical dedupe keys.
  const parsedTasks = tasks
    .map(({ description, time }) => ({ description, time }))
    .sort((a, b) => a.description.localeCompare(b.description));

  try {
    return await protectAiOperation(
      {
        operationType: "generateSchedule",
        quotaCost: 1,
        rateLimit: { windowMs: 60_000, max: 10 },
        dedupeTtlMs: 600_000,
        inputToDedupeKey: () => JSON.stringify({ hours, tasks: parsedTasks }),
        inputToLogText: () => JSON.stringify({ hours, tasks: parsedTasks }),
      },
      { db: createProtectionDb(context.entities), rateLimiter },
      context.user.id,
      rawArgs,
      async () => {
        console.log("Calling open AI api");
        const generatedSchedule = await generateScheduleWithGpt(tasks, hours);
        if (generatedSchedule === null) {
          throw new Error("Encountered a problem in communication with OpenAI");
        }

        await context.entities.GptResponse.create({
          data: {
            user: { connect: { id: context.user.id } },
            content: JSON.stringify(generatedSchedule),
          },
        });

        return generatedSchedule;
      },
    );
  } catch (e) {
    if (e instanceof ProtectionError) {
      throw new HttpError(e.statusCode, e.message, e.data);
    }
    throw e;
  }
};
```

5. 删除旧的 `isUserSubscribed` 函数（逻辑已移入保护层）。

- [ ] **Step 3: 验证 wasp 编译通过**

Run: `tail -50 /private/tmp/claude-501/-Users-Kevin-kevin-open-saas-interview/05acf20f-3eef-4a26-b967-f5bc61762c19/tasks/b3hwf2y2l.output`（wasp start 后台日志）

Expected: 无编译错误；`[Server]` 无 TypeScript error 输出。若出现 error，修复后重复本步。

- [ ] **Step 4: 运行全部单测**

Run: `cd template/app && export PATH="/Users/Kevin/.nvm/versions/node/v24.14.1/bin:$PATH" && npm test`

Expected: 全部 PASS

- [ ] **Step 5: Commit**

```bash
git add template/app/src/ai-protection/env.ts template/app/src/env.ts template/app/src/demo-ai-app/operations.ts
git commit -m "feat: integrate AI protection into generateGptResponse"
```

---

### Task 9: 全量质量检查

**Files:** 无新增（只验证与修复）

- [ ] **Step 1: ESLint**

Run: `cd /Users/Kevin/kevin/open-saas-interview && export PATH="/Users/Kevin/.nvm/versions/node/v24.14.1/bin:$PATH" && npm run lint`

Expected: 无 error（`npm run lint:fix` 可自动修复可修复项；如有 warning 一并处理）

- [ ] **Step 2: Prettier**

Run: `cd /Users/Kevin/kevin/open-saas-interview && export PATH="/Users/Kevin/.nvm/versions/node/v24.14.1/bin:$PATH" && npm run prettier:format`

Expected: 格式化完成；再次 `npm run prettier:check` 通过

- [ ] **Step 3: 单测全绿**

Run: `cd template/app && export PATH="/Users/Kevin/.nvm/versions/node/v24.14.1/bin:$PATH" && npm test`

Expected: 全部 PASS

- [ ] **Step 4: Commit 修复**

```bash
git add -A template/app
git commit -m "chore: fix lint and formatting"
```

（若无变更则跳过提交）

---

### Task 10: 并发冒烟脚本 + 端到端验证

**Files:**
- Create: `template/app/scripts/concurrency-smoke.mjs`

- [ ] **Step 1: 写冒烟脚本**

`template/app/scripts/concurrency-smoke.mjs`：

```js
#!/usr/bin/env node
/**
 * AI protection concurrency smoke test.
 *
 * Prereqs:
 *   - `wasp start` running (API on http://localhost:3001)
 *   - Server started with stub OpenAI:
 *       OPENAI_BASE_URL=http://localhost:8787/v1 OPENAI_API_KEY=sk-local-placeholder wasp start
 *   - Node 24+
 *
 * Run:
 *   export DATABASE_URL=$(sed -n 's/^DATABASE_URL=//p' .wasp/out/server/.env)
 *   node scripts/concurrency-smoke.mjs
 *
 * Asserts:
 *   1. 20 concurrent identical requests -> exactly 1 real AI call (dedupe + claim)
 *   2. no 5xx / 402 responses
 *   3. retry after settle -> 200 replay, still 1 AI call
 *   4. 3 distinct requests -> 3 more AI calls
 *   5. user credits dropped by exactly 1 (reserve-commit, no overspend)
 */
import { createServer } from "node:http";
import { PrismaClient } from "@prisma/client";

const API_URL = process.env.API_URL ?? "http://localhost:3001";
const STUB_PORT = Number(process.env.STUB_PORT ?? 8787);

let aiCalls = 0;

// --- 1. Stub OpenAI ---------------------------------------------------------
const stub = createServer((req, res) => {
  if (req.method === "GET" && req.url === "/stats") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ aiCalls }));
    return;
  }
  if (req.method === "POST" && req.url === "/v1/chat/completions") {
    aiCalls += 1;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        id: "chatcmpl-smoke",
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: "gpt-3.5-turbo",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: "call_smoke",
                  type: "function",
                  function: {
                    name: "parseTodaysSchedule",
                    arguments: '{"tasks":[],"taskItems":[]}',
                  },
                },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      }),
    );
    return;
  }
  res.writeHead(404);
  res.end();
});
await new Promise((resolve) => stub.listen(STUB_PORT, resolve));
console.log(`[stub] OpenAI stub listening on :${STUB_PORT}`);

// --- 2. Auth: signup -> verify -> login ------------------------------------
const email = `smoke-${Date.now()}@example.com`;
const password = "smoke-password-123";

async function post(path, body, headers = {}) {
  const res = await fetch(`${API_URL}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

const signup = await post("/auth/email/signup", { email, password });
if (signup.status !== 200) {
  throw new Error(`signup failed: ${JSON.stringify(signup)}`);
}

const prisma = new PrismaClient();
const identity = await prisma.authIdentity.findUniqueOrThrow({
  where: {
    providerName_providerUserId: { providerName: "email", providerUserId: email },
  },
});
const providerData = JSON.parse(identity.providerData);
providerData.isEmailVerified = true;
await prisma.authIdentity.update({
  where: {
    providerName_providerUserId: { providerName: "email", providerUserId: email },
  },
  data: { providerData: JSON.stringify(providerData) },
});
const user = await prisma.user.findFirstOrThrow({
  where: {
    auth: { identities: { some: { providerName: "email", providerUserId: email } } },
  },
});
console.log(`[auth] user ${email} verified (initial credits=${user.credits})`);

const login = await post("/auth/email/login", { email, password });
if (login.status !== 200 || !login.body?.sessionId) {
  throw new Error(`login failed: ${JSON.stringify(login)}`);
}
const authHeaders = { authorization: `Bearer ${login.body.sessionId}` };
console.log("[auth] logged in");

const call = (hours) => post("/operations/generate-gpt-response", { hours }, authHeaders);

// --- 3. Phase 1: 20 concurrent identical requests ---------------------------
console.log("[phase1] firing 20 concurrent identical requests (hours=4)...");
const results = await Promise.all(Array.from({ length: 20 }, () => call(4)));
const hardFailures = results.filter(
  (r) => r.status >= 500 || r.status === 402,
);
if (hardFailures.length > 0) {
  throw new Error(
    `phase1: ${hardFailures.length} hard failures: ${JSON.stringify(hardFailures.slice(0, 3))}`,
  );
}
if (aiCalls !== 1) {
  throw new Error(`phase1: expected exactly 1 real AI call, got ${aiCalls}`);
}
console.log(
  `[phase1] PASS: 20 requests -> 1 AI call (statuses: ${results.map((r) => r.status).join(",")})`,
);

// --- 4. Retry after settle -> replay ----------------------------------------
const retry = await call(4);
if (retry.status !== 200) {
  throw new Error(`retry: expected 200 replay, got ${retry.status}`);
}
if (aiCalls !== 1) {
  throw new Error(`retry: dedupe replay should not call AI, got ${aiCalls} calls`);
}
console.log("[retry] PASS: identical request replayed, still 1 AI call");

// --- 5. Phase 2: distinct requests ------------------------------------------
const distinct = await Promise.all([call(5), call(6), call(7)]);
if (distinct.some((r) => r.status >= 400)) {
  throw new Error(`phase2: non-2xx: ${JSON.stringify(distinct)}`);
}
if (aiCalls !== 4) {
  throw new Error(`phase2: expected 4 AI calls total, got ${aiCalls}`);
}
console.log("[phase2] PASS: 3 distinct requests -> 3 AI calls");

// --- 6. Credits check (reserve-commit, no overspend) ------------------------
const updated = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
if (updated.credits !== user.credits - 1) {
  throw new Error(
    `credits: expected ${user.credits - 1}, got ${updated.credits}`,
  );
}
console.log(`[credits] PASS: ${user.credits} -> ${updated.credits}`);

// --- 7. Cleanup -------------------------------------------------------------
const auth = await prisma.auth.findUniqueOrThrow({ where: { userId: user.id } });
await prisma.auth.delete({ where: { id: auth.id } });
await prisma.user.delete({ where: { id: user.id } });
await prisma.$disconnect();
stub.close();
console.log("ALL SMOKE TESTS PASSED");
```

- [ ] **Step 2: 重启 wasp start（带 stub OpenAI 环境变量）**

Run:
```bash
pkill -f "wasp-bin start"; sleep 2
cd /Users/Kevin/kevin/open-saas-interview/template/app
export PATH="/Users/Kevin/.nvm/versions/node/v24.14.1/bin:$PATH"
OPENAI_BASE_URL=http://localhost:8787/v1 OPENAI_API_KEY=sk-local-placeholder wasp start  # 后台运行
```
Wait ~60s 后确认日志：`[Server] Server listening on port 3001`

- [ ] **Step 3: 运行冒烟脚本**

Run:
```bash
cd /Users/Kevin/kevin/open-saas-interview/template/app
export PATH="/Users/Kevin/.nvm/versions/node/v24.14.1/bin:$PATH"
export DATABASE_URL=$(sed -n 's/^DATABASE_URL=//p' .wasp/out/server/.env)
node scripts/concurrency-smoke.mjs
```

Expected:
```
[phase1] PASS: 20 requests -> 1 AI call (...)
[retry] PASS: identical request replayed, still 1 AI call
[phase2] PASS: 3 distinct requests -> 3 AI calls
[credits] PASS: 3 -> 2
ALL SMOKE TESTS PASSED
```

- [ ] **Step 4: 手动检查日志表（可选）**

Run: `docker exec wasp-dev-db-OpenSaaS-565a25e677 psql -U postgresWaspDevUser -d OpenSaaS-565a25e677 -c 'SELECT "userId", "operationType", status, "latencyMs" FROM "AIOperationLog" ORDER BY "createdAt" DESC LIMIT 10;'`

Expected: 1 行 completed + 若干行 dedupe 冲突记录（无实际 AI 调用的请求行）；in_progress 无残留（失败路径会 markFailed）

- [ ] **Step 5: 恢复 wasp start 正常环境**

Run:
```bash
pkill -f "wasp-bin start"; sleep 2
cd /Users/Kevin/kevin/open-saas-interview/template/app
export PATH="/Users/Kevin/.nvm/versions/node/v24.14.1/bin:$PATH"
wasp start  # 后台运行，恢复无 stub 环境
```

- [ ] **Step 6: Commit**

```bash
git add template/app/scripts/concurrency-smoke.mjs
git commit -m "test: add concurrency smoke script for AI protection"
```

---

### Task 11: 文档 + PR 准备

**Files:**
- Modify: `template/app/README.md`（追加 AI protection 说明）
- Create: `PR_DESCRIPTION.md`（PR 说明草稿，供用户审阅）

- [ ] **Step 1: README 追加配置说明**

`template/app/README.md` 末尾追加：

```markdown
## AI Operation Protection

`generateGptResponse` runs through a reusable protection layer (`src/ai-protection/`):
quota reserve-commit, rate limiting, prompt deduplication and call logging.

- `RATE_LIMIT_STORE=memory|db` (default `memory`): `memory` is a per-instance
  sliding window; switch to `db` for multi-instance deployments (fixed window,
  backed by the `RateLimitCounter` table).
- Rate limit / dedupe TTL / quota cost are configured per operation in
  `protectAiOperation` (see `src/demo-ai-app/operations.ts`).
- Every attempt is recorded in `AIOperationLog` (status: in_progress /
  completed / failed).

Run the concurrency smoke test:
```bash
export DATABASE_URL=$(sed -n 's/^DATABASE_URL=//p' .wasp/out/server/.env)
node scripts/concurrency-smoke.mjs   # requires wasp start with OPENAI_BASE_URL stub, see script header
```
```

- [ ] **Step 2: 写 PR 说明草稿**

`PR_DESCRIPTION.md`（仓库根目录，PR 时复制到 GitHub 描述框；PR 合并后可删除）：

```markdown
## Summary

为 AI 操作（`generateGptResponse`）接入可复用的成本与滥用控制层 `src/ai-protection/`：
额度预留-提交/回滚、可插拔限流（内存/DB）、基于 DB 唯一约束的 claim-based 去重、全量调用日志。

## 背景

现有 `operations.ts` 的 credits 检查是「先读后扣、成功才扣」：检查与扣费非原子，
并发请求可全部通过检查导致积分超支（原代码注释自曝该弱点）。

## 设计取舍

1. **额度：reserve-commit**。单条原子 SQL（`UPDATE ... WHERE credits >= cost`）完成检查+扣费；
   OpenAI 失败时原子退款。彻底堵死并发超支。
2. **去重：claim-based + DB 唯一约束**。调用前 INSERT 日志行（status=in_progress），
   唯一约束（user+op+key+TTL 桶）即并发仲裁者：插入成功者执行，冲突者回放已完成结果 /
   429 等待 / 原子接管失败重试。单纯的「先查后调」在竞态下会漏，故选占位式。
   窗口用确定性 TTL 桶（floor(now/ttl)*ttl），过期自然放行，无清理任务。
3. **限流：可插拔 store**。`memory`（滑动窗口，单实例快路径）与 `db`
   （固定窗口 + RateLimitCounter 表，多实例安全）双实现，`RATE_LIMIT_STORE` 切换；
   固定窗口在窗口边界允许 2×max 突发，已在文档中说明取舍。
4. **错误语义**：429（限流/去重进行中）、402（额度不足）、502（AI 失败已退款）、
   401 沿用。核心抛 `ProtectionError`，action 边界映射为 `HttpError`。
5. **可测试性**：核心逻辑纯 TS 零 Wasp 依赖（接口注入 db/store），vitest 单测覆盖
   11 条路径；`ProtectionDb` 门面唯一接触 Prisma。

## 测试方式

- **单测**（`npm test`）：dedup 规范化/哈希/窗口桶、内存与 DB 限流器、ProtectionDb
  （P2002 冲突处理）、protectAiOperation 全流程（成功/限流/回放/进行中/接管/竞态/
  额度不足/失败退款/用户缺失/quotaCost=0）
- **并发冒烟**（`scripts/concurrency-smoke.mjs`，stub OpenAI）：20 个并发相同请求
  → 恰好 1 次真实 AI 调用；重试命中回放；3 个不同请求 → 3 次调用；积分恰好 -1（无超支）
- lint / prettier / wasp 编译全过

## 后续规划

- admin 日志查询页（复用现有 admin dashboard）
- Redis 限流存储实现
- Idempotency-Key 严格幂等协议（当前去重基于 prompt 内容）
- token 用量与成本估算落库（模型已预留 tokensUsed/costEstimate 字段）
```

- [ ] **Step 3: 最终验证**

Run:
```bash
cd /Users/Kevin/kevin/open-saas-interview
export PATH="/Users/Kevin/.nvm/versions/node/v24.14.1/bin:$PATH"
npm run lint && npm run prettier:check
cd template/app && npm test
git status --short   # 确认无遗漏文件
git log --oneline main..HEAD   # 确认提交历史干净
```

Expected: 全部通过；提交历史为 11 个功能提交（+2 docs 提交）

- [ ] **Step 4: Commit 文档**

```bash
git add template/app/README.md PR_DESCRIPTION.md
git commit -m "docs: document AI protection config and PR summary"
```

- [ ] **Step 5: 交付说明（不自动执行，向用户确认后执行）**

将分支推送到 `floatboatai/open-saas-interview`（或用 fork），用 `PR_DESCRIPTION.md` 内容创建 PR。需用户确认 GitHub 访问方式（直接 push 权限 vs fork + PR）。

---

## Self-Review

- **Spec 覆盖**：额度 ✓（Task 6/7）、限流 ✓（Task 4/5/7）、去重 ✓（Task 2/6/7）、日志 ✓（Task 6/7 的 AIOperationLog 写入）、错误语义 ✓（Task 7）、RATE_LIMIT_STORE ✓（Task 8）、main.wasp entities ✓（Task 1）、并发冒烟 ✓（Task 10）
- **非目标**：admin 页/Redis/幂等键均未实现，仅在 PR 说明的后续规划中提及 ✓
- **类型一致性**：`ProtectionDb`、`RateLimitStore`、`DedupeClaimResult` 接口在 Task 6/7 中签名一致；`computeDedupeWindow` 返回 `bigint`，Prisma BigInt 字段接受 ✓
- **已知取舍**：DB 限流为固定窗口（边界突发 2×max）；dedupe 回放信任已完成行存过的 outputText；`createRateLimitStore` 的 prisma 参数类型用 `RateLimitCounterModel`（结构化兼容）
