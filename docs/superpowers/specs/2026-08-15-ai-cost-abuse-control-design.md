# AI 成本与滥用控制 — 设计文档

日期：2026-08-15
状态：已确认（用户批准）
分支：`feat/ai-cost-abuse-control`

## 背景与问题

现有 `src/demo-ai-app/operations.ts` 的 `generateGptResponse` 存在已知滥用漏洞（代码注释自曝）：

- **非原子检查-扣费**：先读 `User.credits > 0`，OpenAI 调用**成功后**才扣费。并发 N 个请求都能通过检查 → 积分超支
- **无限流**：同一用户可高频调用，成本无上限
- **无去重**：相同 prompt 重复提交 = 重复计费
- **无调用日志**：无审计追踪，无法定位滥用者与成本来源

## 目标

为 AI 操作提供可复用的保护层，覆盖：

1. **额度（quota）**：预留-提交/回滚（reserve-commit）语义，原子防并发超支
2. **限流（rate limit）**：可插拔存储（内存 / Postgres），每操作独立配置
3. **去重（dedup）**：规范化 prompt 哈希 + TTL 窗口 + DB 唯一约束，防重复调用与并发双发
4. **调用日志（logging）**：全量审计（输入/输出/状态/耗时/成本估算）

订阅用户跳过额度预留，但仍受限流与去重约束（成本控制对所有人生效）。

## 非目标（scope 控制）

- 不做管理员日志查询页面（列为后续规划）
- 不做 Redis 限流实现（内存 + Postgres 覆盖单机/多实例两档）
- 不做严格幂等键（Idempotency-Key）协议
- 不改前端调用方式（action 签名不变）

## 数据模型

`schema.prisma` 新增两张表：

```prisma
model AIOperationLog {
  id            String   @id @default(uuid())
  createdAt     DateTime @default(now())
  userId        String
  operationType String
  dedupeKey     String   // sha256(normalizedPrompt)
  inputText     String
  outputText    String?
  status        String   // "completed" | "failed" | "deduplicated"
  tokensUsed    Int?
  costEstimate  Float?   // tokens × 单价（可配置）
  errorMessage  String?
  latencyMs     Int?

  @@unique([userId, operationType, dedupeKey, createdAt])
  @@index([userId, createdAt])
}

model RateLimitCounter {
  id          Int      @id @default(autoincrement())
  key         String   // `${userId}:${operationType}`
  windowStart BigInt   // 窗口起始时间戳（ms）
  count       Int

  @@unique([key, windowStart])
}
```

要点：

- 去重唯一约束 `[userId, operationType, dedupeKey, createdAt]` 天然挡住并发双发（同窗口重复插入即冲突）；TTL 窗口由 `createdAt` 时间范围判断，无清理任务
- 额度复用现有 `User.credits`，不加新字段
- `RateLimitCounter` 的 upsert + 原子比较实现多实例安全的计数

## 核心模块（纯 TS，零 Wasp 依赖）

```
src/ai-protection/
├── quota.ts          // reserveCredits / refundCredits
├── rate-limit/
│   ├── store.ts      // RateLimitStore 接口
│   ├── in-memory.ts  // 滑动窗口（Map + 时间戳数组）
│   └── db.ts         // Postgres 实现（RateLimitCounter 表）
├── dedup.ts          // normalizePrompt / buildDedupeKey / 查找与回放
├── log.ts            // recordAttempt
├── protect.ts        // protectAiOperation 编排
└── config.ts         // 每操作配置类型与默认值
```

### 接口

```ts
// store.ts
interface RateLimitStore {
  consume(key: string, windowMs: number, max: number): Promise<{
    allowed: boolean;
    retryAfterMs?: number;
  }>;
}

// config.ts
interface AiOperationConfig {
  operationType: string;
  quotaCost?: number;                    // 默认 1；订阅用户忽略
  rateLimit?: { windowMs: number; max: number };   // 可选，不配则不限
  dedupeTtlMs?: number;                  // 可选，不配则不去重
}

// protect.ts
async function protectAiOperation<TArgs, TResult>(
  config: AiOperationConfig,
  execute: (args: TArgs, context: Context) => Promise<TResult>,
): Promise<TResult>;
```

### 编排流程

```
用户请求
  ├─ 1. 限流检查（store 接口）           → 超限 → 429 + retryAfterMs
  ├─ 2. 去重查找（TTL 窗口内命中）        → 命中 → 200 + 回放结果（status=deduplicated，不扣费）
  ├─ 3. 额度预留（原子 UPDATE，事务开启）  → credits ≤ 0 → 402
  ├─ 4. 执行真实 AI 调用
  │     ├─ 成功 → 写日志（completed）+ 提交事务
  │     └─ 失败 → 退款（原子 +1）+ 写日志（failed）+ 回滚 → 502
  └─ 5. 返回结果
```

顺序依据：限流最便宜放最前；去重次之（省一次 AI 调用与 DB 写）；额度预留是花钱路径的守门员。

## Wasp 集成

1. **改造 `generateGptResponse`**：签名不变，内部改为

```ts
export const generateGptResponse = protectAiOperation(
  {
    operationType: "generateSchedule",
    quotaCost: 1,
    rateLimit: { windowMs: 60_000, max: 10 },
    dedupeTtlMs: 600_000,
  },
  async (args, context) => {
    // 现有逻辑：generateScheduleWithGpt + 存 GptResponse
  },
);
```

2. **`main.wasp.ts`**：`action(generateGptResponse, { entities: [..., "AIOperationLog", "RateLimitCounter"] })`
3. **环境变量** `RATE_LIMIT_STORE=memory|db`（默认 `memory`），模块级读取一次
4. **订阅判断**：复用 `isUserSubscribed()`（src/payment/plans.ts）

## 错误语义

| 场景 | 状态码 | 说明 |
|---|---|---|
| 限流超限 | 429 | `{ message, retryAfterMs }` |
| 额度不足（非订阅） | 402 | 沿用现有文案风格 |
| OpenAI 失败 | 502 | 已退款 + 日志记 failed |
| 去重命中 | 200 | 回放结果 + `deduplicated: true` |
| 未登录 | 401 | 现有行为不变 |

## 测试与验证

1. **vitest 单测**（核心纯 TS）：quota 边界、内存限流窗口/retryAfter、dedup 规范化与 TTL、protect 全流程 5 条路径（成功/限流/去重/额度不足/失败退款），store 接口用 mock
2. **并发冒烟脚本** `scripts/concurrency-smoke.ts`：种子用户 token 并发 20 请求，断言 credits 只减 1 且不为负
3. **手动验证**：`wasp start` 后实操 demo-app + 查 AIOperationLog 表
4. **lint/prettier** 通过（仓库 eslint + prettier 配置）

## 后续规划（PR 说明中提及）

- admin 日志查询页（复用 admin dashboard）
- Redis 限流存储实现
- Idempotency-Key 严格幂等协议
- 成本估算接入真实 token 计价（目前按配置单价）
