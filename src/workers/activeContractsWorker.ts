// BF_SERVER_v864_ACTIVE_CONTRACTS - the renewal engine and statement intake, hourly, one instance at a time (claimedTick).
// Each tick: funded applications become contracts, renewal rules are applied (src/activeContracts/engine.ts), and lender
// statements filed from email are read into "pending review" (src/activeContracts/statements.ts). ACTIVE_CONTRACTS_ENGINE=off
// stops it.
import type { Pool } from "pg";
import { claimedTick } from "./claim.js";
import { defaultEngineDeps, runEngineTick } from "../activeContracts/engine.js";
import { defaultStatementDeps, scanInboundStatements } from "../activeContracts/statements.js";
import type { Q } from "../activeContracts/repo.js";

const TICK_MS = 60 * 60_000;

export function startActiveContractsWorker(pool: Pool): { stop: () => void } {
  let stopped = false;
  let running = false;
  const db = pool as unknown as Q;
  const tickUnclaimed = async () => {
    if (stopped || running || String(process.env.ACTIVE_CONTRACTS_ENGINE ?? "").toLowerCase() === "off") return;
    running = true;
    try {
      const out = await runEngineTick(db, await defaultEngineDeps());
      const statements = await scanInboundStatements(db, await defaultStatementDeps());
      if (out.created || out.status_changes || out.failed || statements) console.info({ event: "active_contracts_tick", ...out, statements });
    } catch (err) {
      console.error("[active-contracts] tick failed:", (err as Error)?.message ?? err);
    } finally {
      running = false;
    }
  };
  const tick = claimedTick("active_contracts", tickUnclaimed);
  const timer = setInterval(() => { void tick(); }, TICK_MS);
  setTimeout(() => { void tick(); }, 90_000);
  return { stop: () => { stopped = true; clearInterval(timer); } };
}
