// BF_SERVER_BLOCK_v616 - runs automation steps that are due (after a wait, a quiet-hours
// hold or a retry). Triggers run their first steps immediately; this picks up the rest.
import type { Pool } from "pg";

export function startAutomationWorker(_pool: Pool, intervalMs = 60_000): { stop: () => void } {
  let stopped = false;
  let running = false;
  let converted = false;
  let lastDaily = 0;
  const tick = async () => {
    if (stopped || running) return;
    running = true;
    try {
      const { defaultDeps, runDue } = await import("../modules/automation/automationEngine.js");
      const deps = await defaultDeps();
      // BF_SERVER_v786_WORKFLOW_GRAPH - on startup, convert every v1 rule to a workflow graph (idempotent),
      // then every 15 minutes evaluate the date.relative and no_reply triggers.
      const graph = await import("../modules/automation/graphEngine.js");
      if (!converted) {
        try { await graph.convertV1Rules(deps.query); converted = true; } catch (err: any) { console.error("[automation-worker] v1 conversion failed", { message: err?.message ?? String(err) }); }
      }
      if (Date.now() - lastDaily >= 15 * 60_000) {
        lastDaily = Date.now();
        try { await graph.runDailyTriggers(deps); } catch (err: any) { console.error("[automation-worker] daily triggers failed", { message: err?.message ?? String(err) }); }
      }
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
