// BF_SERVER_PRODUCT_KNOWLEDGE_SYNC_v1
// Periodically reconciles Maya's product knowledge (ai_knowledge) with lender_products so that
// products added manually - via the portal or direct SQL - become searchable without a manual
// reingest. Runs once ~15s after startup, then every 10 minutes. Non-overlapping.
import type { Pool } from "pg";
import { reconcileProductKnowledge } from "../modules/ai/productIngest.service.js";

const INTERVAL_MS = 10 * 60 * 1000;
const KICKOFF_MS = 15 * 1000;

export function startProductKnowledgeWorker(pool: Pool): { stop: () => void } {
  let running = false;

  const tick = async (): Promise<void> => {
    if (running) return;
    running = true;

    try {
      const result = await reconcileProductKnowledge(pool);
      if (result.ingested || result.pruned) {
        console.log(`[product-knowledge] ingested ${result.ingested}, pruned ${result.pruned}`);
      }
    } catch (err) {
      console.error("[product-knowledge] reconcile failed:", (err as { message?: string })?.message ?? err);
    } finally {
      running = false;
    }
  };

  const kickoff = setTimeout(() => { void tick(); }, KICKOFF_MS);
  const timer = setInterval(() => { void tick(); }, INTERVAL_MS);

  return {
    stop: () => {
      clearTimeout(kickoff);
      clearInterval(timer);
    },
  };
}
