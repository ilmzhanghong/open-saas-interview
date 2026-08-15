# AI 成本与滥用控制（AI Cost & Abuse Control）

## Summary

为 AI 操作（`generateGptResponse`）接入可复用的成本与滥用控制层 `src/ai-protection/`：
**额度预留-提交/回滚（reserve-commit）、可插拔限流（内存/DB）、基于 DB 唯一约束的 claim-based 去重、全量调用日志**。前端调用方式零改动。

## 背景

现有 `operations.ts` 的 credits 逻辑是「先读后扣、成功才扣」：检查与扣费非原子，并发请求可全部通过检查导致积分超支——原代码注释自曝该弱点（"users can theoretically abuse this and spend more credits than they have"）。本 PR 从根上修复。

## 设计取舍

1. **额度：reserve-commit**。单条原子 SQL（`UPDATE ... SET credits = credits - cost WHERE id = ? AND credits >= cost`）完成检查+扣费（即预留），OpenAI 失败时原子退款。并发下积分不可能为负，也不可能超支。
2. **去重：claim-based + DB 唯一约束**。调用前先 INSERT 日志行（status=`in_progress`），唯一约束（user + op + 规范化 prompt 哈希 + TTL 桶）即并发仲裁者：插入成功者执行；冲突者按已有行状态决策——已完成则回放结果（不扣费）、进行中则 429、失败则原子接管重试。单纯「先查后调」在竞态下会漏，故选占位式。窗口用确定性 TTL 桶（`floor(now/ttl)*ttl`），过期自然放行，无需清理任务。
3. **限流：可插拔 store**。`RateLimitStore` 接口 + 双实现：`memory`（滑动窗口，单实例快路径）与 `db`（固定窗口 + `RateLimitCounter` 表，多实例安全），`RATE_LIMIT_STORE=memory|db` 切换（默认 memory）。取舍：固定窗口在窗口边界允许 2×max 突发，已在文档说明。
4. **错误语义**：429（限流/去重进行中）、402（额度不足）、502（AI 失败且已退款）、401 沿用。核心抛 `ProtectionError`，action 边界映射为 `HttpError`。
5. **可测试性**：核心逻辑纯 TS、零 Wasp 依赖（db/rateLimiter 接口注入），vitest 单测覆盖 11 条编排路径；`ProtectionDb` 门面是唯一接触 Prisma 的胶水。
6. **日志**：每次尝试写入 `AIOperationLog`（status 状态机 in_progress → completed/failed，含输入/输出/耗时/错误），模型预留 tokensUsed/costEstimate 字段供成本估算。

## 测试方式

- **单测**（`npm test`，31 个用例）：dedup 规范化/哈希/窗口桶；内存与 DB 限流器（窗口滑动、retryAfter、键隔离、upsert 键构造）；ProtectionDb（P2002 冲突处理、原子扣费/退款、失败接管竞态）；protectAiOperation 全流程（成功/订阅跳过额度/限流/回放/进行中/接管/接管竞态/额度不足/失败退款/用户缺失/quotaCost=0）
- **并发冒烟**（`scripts/concurrency-smoke.mjs`，stub OpenAI 端到端）：实测结果：
  - 20 个并发相同请求 → **恰好 1 次真实 AI 调用**（其余 200 回放或 429 等待）
  - 相同请求重试 → 回放命中，AI 调用数不变
  - 3 个不同请求 → 3 次调用
  - 积分 10 → 6（恰好 4 次真实调用扣 4，无超支、无重复扣费）
- lint / prettier / wasp 编译全过

## 变更文件

- `template/app/schema.prisma` + 迁移：`AIOperationLog`、`RateLimitCounter` 两张表
- `template/app/src/ai-protection/`：核心模块（errors/config/dedup/db/protect + rate-limit 双实现 + env）
- `template/app/src/demo-ai-app/operations.ts`：`generateGptResponse` 接入保护层（签名不变）
- `template/app/src/env.ts`：`RATE_LIMIT_STORE` 环境变量
- `template/app/scripts/concurrency-smoke.mjs`：端到端冒烟
- `template/app/README.md`：配置说明
- 顺带修复：`template/blog/src/env.d.ts` 冗余 triple-slash 引用（既有 eslint 错误）、`.prettierignore` 忽略 `.astro/` 生成目录

## 后续规划

- admin 日志查询页（复用现有 admin dashboard）
- Redis 限流存储实现
- Idempotency-Key 严格幂等协议（当前去重基于 prompt 内容）
- token 用量与成本估算落库（模型已预留字段）
