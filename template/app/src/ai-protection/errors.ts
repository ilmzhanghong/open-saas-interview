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
