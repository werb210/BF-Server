// BF_SERVER_v867_BROKER_TOOLS_2 - the broker tools' background work, hourly, one instance at a time (claimedTick). Each step checks
// its own plan feature and logs its own failure; one failing step never stops the others. BROKER_TOOLS_WORKER=off
// stops it.
import type { Pool } from "pg";
import { claimedTick } from "./claim.js";
import type { Q } from "../brokerTools/common.js";
import { featureOn, type BrokerFeature } from "../brokerTools/platform.js";

type Step = { name: string; feature: BrokerFeature; run: (db: Q, now: Date) => Promise<number> };

export const STEPS: Step[] = [
  // Confirmed vendor invoices: equipment goes onto the Active Contract once the file has one.
  { name: "invoice_assets", feature: "invoice_reading", run: async (db) => (await import("../brokerTools/invoices.js")).syncPendingInvoiceAssets(db) },
  // Approved credit lines: expired lines are marked; a reminder task before each expiry date.
  { name: "credit_line_reminders", feature: "credit_lines", run: async (db, now) => (await import("../brokerTools/creditLines.js")).creditLineReminders(db, now.toISOString().slice(0, 10)) },
  // Contracts out for signature: the signed PDF is filed when everyone has signed.
  { name: "contract_signatures", feature: "contract_templates", run: async (db) => (await import("../brokerTools/contracts.js")).refreshSentContracts(db) },
];

export async function runBrokerToolsTick(db: Q, now = new Date()): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const step of STEPS) {
    try {
      if (!(await featureOn(step.feature))) continue;
      out[step.name] = await step.run(db, now);
    } catch (err) {
      console.error("[broker-tools] worker step failed", { step: step.name, message: err instanceof Error ? err.message : String(err) });
    }
  }
  return out;
}

const TICK_MS = 60 * 60_000;

export function startBrokerToolsWorker(pool: Pool): { stop: () => void } {
  let stopped = false;
  let running = false;
  const db = pool as unknown as Q;
  const tickUnclaimed = async () => {
    if (stopped || running || String(process.env.BROKER_TOOLS_WORKER ?? "").toLowerCase() === "off") return;
    running = true;
    try {
      const out = await runBrokerToolsTick(db);
      if (Object.values(out).some((n) => n > 0)) console.info({ event: "broker_tools_tick", ...out });
    } finally {
      running = false;
    }
  };
  const tick = claimedTick("broker_tools", tickUnclaimed);
  const timer = setInterval(() => { void tick(); }, TICK_MS);
  setTimeout(() => { void tick(); }, 120_000);
  return { stop: () => { stopped = true; clearInterval(timer); } };
}
