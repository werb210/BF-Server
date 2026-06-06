// BF_SERVER_BLOCK_v744_OUTREACH_AUTOADVANCE_COMPLETE
// Polls the shared submissions@ inbox via Graph and advances a BI outreach lead
// New/Contacted -> Engaged when an inbound message's sender matches a
// bi_contacts.email. Mirrors the read-receipt worker. Re-scan-safe: the underlying
// UPDATE is forward-only, so re-reading the same message is a no-op.
// HONEST LIMITATION: requires at least one staff user with an O365 token that can
// read submissions@ (Mail.Read.Shared); if none, the worker quietly no-ops.
import type { Pool } from "pg";
import { getGraphForUser } from "../modules/o365/graphClient.js";
import { bumpBiOutreachToEngagedByEmail } from "../services/biOutreach.js";

const SHARED_MAILBOX = "submissions@boreal.financial";
const TICK_MS = 300_000;     // 5 minutes
const LOOKBACK_MIN = 20;     // overlap the interval; forward-only update dedupes

export function startBiOutreachEmailReplyWorker(pool: Pool): { stop: () => void } {
  let stopped = false;
  let running = false;

  const tick = async () => {
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
        } catch {
          /* try the next connected staffer */
        }
      }
    } catch {
      /* best-effort: a transient Graph/DB error must not crash the worker */
    } finally {
      running = false;
    }
  };

  const handle = setInterval(() => { void tick(); }, TICK_MS);
  void tick();
  return {
    stop: () => {
      stopped = true;
      clearInterval(handle);
    },
  };
}
