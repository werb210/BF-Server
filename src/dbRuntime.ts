import { pool } from "./db";
import { logger } from "./platform/logger";
import { config } from "@/config";

export function isTestEnv(): boolean {
  return config.env === "test";
}

const connectionFailureCodes = new Set([
  "57P01",
  "57P02",
  "57P03",
  "08006",
  "08003",
  "08001",
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
]);

export function isDbConnectionFailure(err: unknown): boolean {
  if (!(err instanceof Error)) {
    return false;
  }
  const code = (err as { code?: string }).code;
  if (code && connectionFailureCodes.has(code)) {
    return true;
  }
  const message = err.message.toLowerCase();
  return (
    message.includes("terminating connection") ||
    message.includes("connection terminated") ||
    message.includes("connection refused") ||
    message.includes("connection reset") ||
    message.includes("could not connect") ||
    message.includes("timeout")
  );
}

export function fetchDbFailureCategory(
  err: unknown
): "pool_exhausted" | "connection_failure" | null {
  if (!(err instanceof Error)) {
    return null;
  }
  const code = (err as { code?: string }).code;
  if (code === "53300") {
    return "pool_exhausted";
  }
  if (isDbConnectionFailure(err)) {
    return "connection_failure";
  }
  const message = err.message.toLowerCase();
  if (message.includes("too many clients")) {
    return "pool_exhausted";
  }
  return null;
}

export async function cancelDbWork(processIds: number[]): Promise<void> {
  if (!processIds.length) {
    return;
  }
  try {
    await pool.query("select pg_cancel_backend(pid) from unnest($1::int[]) as pid", [
      processIds,
    ]);
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown_error";
    logger.error("db_cancel_error", { message });
  }
}

export const isTestEnvironment = isTestEnv;
