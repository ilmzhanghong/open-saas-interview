import * as z from "zod";

export const aiProtectionEnvSchema = z.object({
  RATE_LIMIT_STORE: z.enum(["memory", "db"]).default("memory"),
});
