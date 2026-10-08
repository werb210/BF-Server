// BF_SERVER_REPORTS15_18_v786 - refresh today's pipeline snapshot every hour (and once at start).
import type { Pool } from "pg";

export function startPipelineSnapshotWorker(_pool: Pool, everyMs = 60 * 60 * 1000): { stop: () => void } {
  const run = async () => {
    try {
      const { takePipelineSnapshot } = await import("../services/reports/data8.js");
      const n = await takePipelineSnapshot();
      console.info("[pipeline-snapshot] stored", { stages: n });
    } catch (err: unknown) {
      console.warn("[pipeline-snapshot] failed", err instanceof Error ? err.message : String(err));
    }
  };
  void run();
  const t = setInterval(() => { void run(); }, everyMs);
  t.unref();
  return { stop: () => clearInterval(t) };
}
