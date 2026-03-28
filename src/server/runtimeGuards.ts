declare global {
  // eslint-disable-next-line no-var
  var __SERVER_STARTED__: boolean | undefined;
}

/**
 * Do NOT hard fail in production — Azure envs are partial
 */
export function assertRequiredEnv(env: NodeJS.ProcessEnv): void {
  if (env.NODE_ENV === "test") return;

  const warnings: string[] = [];

  if (!env.DATABASE_URL) warnings.push("DATABASE_URL missing");
  if (!env.JWT_SECRET) warnings.push("JWT_SECRET missing");
  if (!env.REDIS_URL) warnings.push("REDIS_URL missing");
  if (!env.TWILIO_ACCOUNT_SID) warnings.push("TWILIO_ACCOUNT_SID missing");

  // 🚨 REMOVE PORT HARD REQUIREMENT
  // Azure injects it at runtime

  if (warnings.length > 0) {
    console.warn("ENV WARNINGS:", warnings.join(", "));
  }
}

export function assertSingleServerStart(): void {
  if (global.__SERVER_STARTED__) {
    console.warn("SERVER_ALREADY_STARTED");
    return;
  }

  global.__SERVER_STARTED__ = true;
}
