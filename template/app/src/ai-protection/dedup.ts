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
