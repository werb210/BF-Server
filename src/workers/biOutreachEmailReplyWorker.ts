// BF_SERVER_BLOCK_v744_OUTREACH_AUTOADVANCE_COMPLETE
// Polls the shared submissions@ inbox via Graph and advances a BI outreach lead
// New/Contacted -> Engaged when an inbound message's sender matches a BI
// outreach lead's email. Mirrors the read-receipt worker. Re-scan-safe: the
// advance is forward-only, so re-reading the same message is a no-op.
// BF_SERVER_v789_BI_OUTREACH_VIA_API - the lead lives in BI-Server's database;
// bumpBiOutreachToEngagedByEmail asks BI to advance it over HTTP (never throws).
// HONEST LIMITATION: requires at least one staff user with an O365 token that can
// read submissions@ (Mail.Read.Shared); if none, the worker quietly no-ops.
import type { Pool } from "pg";
import { getGraphForUser } from "../modules/o365/graphClient.js";
import { bumpBiOutreachToEngagedByEmail } from "../services/biOutreach.js";
import { logWarn } from "../observability/logger.js";
import { claimedTick } from "./claim.js"; // BF_SERVER_v789_WORKER_CLAIM

const SHARED_MAILBOX = "submissions@boreal.financial";
const TICK_MS = 300_000;     // 5 minutes
const LOOKBACK_MIN = 20;     // overlap the interval; forward-only update dedupes

export function startBiOutreachEmailReplyWorker(pool: Pool): { stop: () => void } {
  let stopped = false;
  let running = false;

  const tickUnclaimed = async () => {
    if (stopped || running) return;
    running = true;
    try {
      const { rows: users } = await pool.query<{ id: string }>(
        `SELECT id FROM users WHERE o365_access_token IS NOT NULL`,
      );
      const sinceIso = new Date(Date.now() - LOOKBACK_MIN * 60_000).toISOString();
      const filter = encodeURIComponent(`receivedDateTime ge ${sinceIso}`);
      for (const u of users) {
        try {
          const graph = await getGraphForUser(pool, u.id);
          if (!graph) continue;
          const r = await graph.fetch(
            `/users/${encodeURIComponent(SHARED_MAILBOX)}/mailFolders/inbox/messages` +
              `?$filter=${filter}&$select=from,receivedDateTime&$top=50`,
          );
          if (!r.ok) continue; // this staffer can't read the shared inbox; try the next
          const j = await r.json();
          for (const m of (j.value ?? [])) {
            const email: string | undefined = m?.from?.emailAddress?.address;
            if (email) await bumpBiOutreachToEngagedByEmail(email);
          }
          return; // one successful read of the shared inbox is enough this cycle
        } catch (err) {
          // try the next connected staffer
          logWarn("bi_outreach_email_reply_user_failed", { userId: u.id, message: err instanceof Error ? err.message : String(err) });
        }
      }
    } catch (err) {
      // best-effort: a transient Graph/DB error must not crash the worker
      logWarn("bi_outreach_email_reply_tick_failed", { message: err instanceof Error ? err.message : String(err) });
    } finally {
      running = false;
    }
  };
  const tick = claimedTick("bi_outreach_email_reply", tickUnclaimed); // BF_SERVER_v789_WORKER_CLAIM - one instance per tick

  const handle = setInterval(() => { void tick(); }, TICK_MS);
  void tick();
  return {
    stop: () => {
      stopped = true;
      clearInterval(handle);
    },
  };
}
