// BF_SERVER_MARKETING_KNOWLEDGE_v1
// Periodically reconciles Maya's marketing knowledge (ai_knowledge) with the
// marketing_template + collateral_assets tables so that marketing messaging and
// uploaded marketing files become searchable by Maya without a manual reingest.
// Runs once ~20s after startup, then every 10 minutes. Non-overlapping.
import type { Pool } from "pg";
import { reconcileMarketingKnowledge } from "../modules/ai/marketingIngest.service.js";

const INTERVAL_MS = 10 * 60 * 1000;
const KICKOFF_MS = 20 * 1000;

export function startMarketingKnowledgeWorker(pool: Pool): { stop: () => void } {
  let running = false;

  const tick = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      const result = await reconcileMarketingKnowledge(pool);
      if (result.ingested || result.pruned) {
        console.log(`[marketing-knowledge] ingested ${result.ingested}, pruned ${result.pruned}`);
      }
    } catch (err) {
      console.error("[marketing-knowledge] reconcile failed:", (err as { message?: string })?.message ?? err);
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
