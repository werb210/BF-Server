// BF_INBOUND_ATTACHMENT_WORKER_v1
// Auto-files inbound email attachments to the CRM. Every few minutes it scans each connected
// user's inbox for recent messages that have attachments and files them to the matching (or
// newly created) contact in that user's silo, reusing fileInboundAttachments. Idempotent: a
// message already represented in contact_documents is skipped before any download, and the DB
// insert dedupes on (silo, source_message_id, filename).
import type { Pool } from "pg";
import { getGraphForUser, type GraphClient } from "../modules/o365/graphClient.js";
import { fileInboundAttachments } from "../services/contactDocuments.js";

const INTERVAL_MS = 5 * 60 * 1000; // poll every 5 minutes
const LOOKBACK_MS = 2 * 24 * 60 * 60 * 1000; // only consider mail from the last 2 days
const INITIAL_DELAY_MS = 30 * 1000; // let startup settle before the first pass

export function startInboundAttachmentWorker(pool: Pool): { stop: () => void } {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const tick = async (): Promise<void> => {
    if (stopped) return;
    try {
      const { rows: users } = await pool.query<{ id: string; silo: string | null }>(
        `SELECT id, silo FROM users WHERE o365_refresh_token IS NOT NULL`,
      );
      const sinceIso = new Date(Date.now() - LOOKBACK_MS).toISOString();
      for (const u of users) {
        if (stopped) break;
        const silo = u.silo || "BF";
        let graph: GraphClient | null = null;
        try {
          graph = await getGraphForUser(pool, u.id);
        } catch {
          graph = null;
        }
        if (!graph) continue;

        let r: Response;
        try {
          r = await graph.fetch(
            `/me/mailFolders/inbox/messages`
              + `?$filter=hasAttachments eq true and receivedDateTime ge ${sinceIso}`
              + `&$select=id,from,hasAttachments&$top=50`,
          );
        } catch {
          continue;
        }
        if (!r.ok) continue;
        const data: any = await r.json();
        const msgs: any[] = Array.isArray(data?.value) ? data.value : [];

        for (const m of msgs) {
          if (stopped) break;
          const mid = String(m?.id ?? "");
          if (!mid) continue;
          try {
            const { rows: ex } = await pool.query(
              `SELECT 1 FROM contact_documents WHERE silo = $1 AND source_message_id = $2 LIMIT 1`,
              [silo, mid],
            );
            if (ex.length) continue; // already filed -> skip before any download/upload
          } catch {
            /* if the pre-check fails, fall through; the insert still dedupes */
          }
          try {
            await fileInboundAttachments({ pool, graph, base: "/me", message: m, silo, ownerId: u.id });
          } catch {
            /* never let one message break the loop */
          }
        }
      }
    } catch {
      /* best-effort background work; swallow and reschedule */
    } finally {
      if (!stopped) timer = setTimeout(() => { void tick(); }, INTERVAL_MS);
    }
  };

  timer = setTimeout(() => { void tick(); }, INITIAL_DELAY_MS);
  return {
    stop: () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}
