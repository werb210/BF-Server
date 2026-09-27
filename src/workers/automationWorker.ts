// BF_SERVER_BLOCK_v616 - runs automation steps that are due (after a wait, a quiet-hours
// hold or a retry). Triggers run their first steps immediately; this picks up the rest.
import type { Pool } from "pg";

export function startAutomationWorker(_pool: Pool, intervalMs = 60_000): { stop: () => void } {
  let stopped = false;
  let running = false;
  const tick = async () => {
    if (stopped || running) return;
    running = true;
    try {
      const { defaultDeps, runDue } = await import("../modules/automation/automationEngine.js");
      const deps = await defaultDeps();
      let n = 0;
      do { n = await runDue(deps, 50); } while (n === 50 && !stopped);
    } catch (err: any) {
      console.error("[automation-worker] tick failed", { message: err?.message ?? String(err) });
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => void tick(), intervalMs);
  void tick();
  return { stop: () => { stopped = true; clearInterval(timer); } };
}
