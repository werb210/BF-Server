// BF_SERVER_SILENT_QUERIES_v678 - a database query that fails and falls back to a default value
// now always leaves a warning in the logs (where, and why), instead of failing silently.
import { logWarn } from "../observability/logger.js";

export function logWarnSwallowed<T>(err: unknown, where: string, fallback?: T): T {
  const message = (err as { message?: string } | null)?.message ?? String(err);
  try {
    logWarn("query_failed_fallback_used", { where, message });
  } catch {
    // The logger itself failed (or a test replaced it): the fallback must still be returned.
    console.warn("[query_failed_fallback_used]", where, message);
  }
  return fallback as T;
}
