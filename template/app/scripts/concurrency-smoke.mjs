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
import { PrismaClient } from "@prisma/client";
import { createServer } from "node:http";
import SuperJSON from "superjson";

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

// Wasp RPC payloads are superjson-serialized, not plain JSON.
async function postOperation(path, body, headers = {}) {
  const res = await fetch(`${API_URL}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: SuperJSON.stringify(body),
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
    providerName_providerUserId: {
      providerName: "email",
      providerUserId: email,
    },
  },
});
const providerData = JSON.parse(identity.providerData);
providerData.isEmailVerified = true;
await prisma.authIdentity.update({
  where: {
    providerName_providerUserId: {
      providerName: "email",
      providerUserId: email,
    },
  },
  data: { providerData: JSON.stringify(providerData) },
});
const user = await prisma.user.findFirstOrThrow({
  where: {
    auth: {
      identities: {
        some: { providerName: "email", providerUserId: email },
      },
    },
  },
});
// Grant enough credits so the quota phases (1 + 3 real calls) don't hit 402.
const initialCredits = 10;
await prisma.user.update({
  where: { id: user.id },
  data: { credits: initialCredits },
});
console.log(
  `[auth] user ${email} verified (credits granted: ${initialCredits})`,
);

const login = await post("/auth/email/login", { email, password });
if (login.status !== 200 || !login.body?.sessionId) {
  throw new Error(`login failed: ${JSON.stringify(login)}`);
}
const authHeaders = { authorization: `Bearer ${login.body.sessionId}` };
console.log("[auth] logged in");

const call = (hours) =>
  postOperation("/operations/generate-gpt-response", { hours }, authHeaders);

// --- 3. Phase 1: 20 concurrent identical requests ---------------------------
console.log("[phase1] firing 20 concurrent identical requests (hours=4)...");
const results = await Promise.all(Array.from({ length: 20 }, () => call(4)));
const hardFailures = results.filter((r) => r.status >= 500 || r.status === 402);
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
// Wait out the rate-limit window (10 req/min) so the retry reaches the
// dedupe layer instead of being blocked by the rate limiter.
console.log("[retry] waiting 61s for the rate-limit window to slide...");
await new Promise((resolve) => setTimeout(resolve, 61_000));
const retry = await call(4);
if (retry.status !== 200) {
  throw new Error(`retry: expected 200 replay, got ${retry.status}`);
}
if (aiCalls !== 1) {
  throw new Error(
    `retry: dedupe replay should not call AI, got ${aiCalls} calls`,
  );
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
// 4 real AI calls total (1 in phase1 + 3 in phase2); dedupe replays don't charge.
const expectedCredits = initialCredits - 4;
const updated = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
if (updated.credits !== expectedCredits) {
  throw new Error(
    `credits: expected ${expectedCredits}, got ${updated.credits}`,
  );
}
console.log(`[credits] PASS: ${initialCredits} -> ${updated.credits}`);

// --- 7. Cleanup -------------------------------------------------------------
// GptResponse rows reference the user with RESTRICT, so remove them first.
await prisma.gptResponse.deleteMany({ where: { userId: user.id } });
const auth = await prisma.auth.findUniqueOrThrow({
  where: { userId: user.id },
});
await prisma.auth.delete({ where: { id: auth.id } });
await prisma.user.delete({ where: { id: user.id } });
await prisma.$disconnect();
stub.close();
console.log("ALL SMOKE TESTS PASSED");
