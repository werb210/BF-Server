// BF_SERVER_BLOCK_v706_READ_RECEIPTS — surface email "opens" on the contact
// timeline. When a recipient's client honors a requested read receipt it emails
// back a "Read: <subject>" message; this worker polls each connected staff inbox
// for those, matches them to the original crm_email_log row, and stamps opened_at.
// HONEST LIMITATIONS: heuristic on the English "Read: " prefix; receipts are
// opt-in (many clients/recipients never send one), so a missing "Opened" does
// NOT mean unread. Processed receipts are marked read so they aren't re-scanned.
import type { Pool } from "pg";
import { getGraphForUser } from "../modules/o365/graphClient.js";

const TICK_MS = 120_000;
const READ_PREFIX = "Read: ";

export function startReadReceiptWorker(pool: Pool): { stop: () => void } {
  let stopped = false;
  let running = false;

  const tick = async () => {
    if (stopped || running) return;
    running = true;
    try {
      const { rows: users } = await pool.query<{ id: string }>(
        `SELECT id FROM users WHERE o365_access_token IS NOT NULL`,
      );
      for (const u of users) {
        try {
          const graph = await getGraphForUser(pool, u.id);
          if (!graph) continue;
          const filter = encodeURIComponent("isRead eq false and startswith(subject,'Read:')");
          const r = await graph.fetch(
            `/me/mailFolders/inbox/messages?$filter=${filter}&$select=id,subject,from,receivedDateTime&$top=25`,
          );
          if (!r.ok) continue;
          const j = await r.json();
          for (const m of (j.value ?? [])) {
            const subject: string = m.subject ?? "";
            if (!subject.startsWith(READ_PREFIX)) continue;
            const originalSubject = subject.slice(READ_PREFIX.length).trim();
            const reader = String(m.from?.emailAddress?.address ?? "").toLowerCase();
            const when = m.receivedDateTime ?? new Date().toISOString();
            if (originalSubject && reader) {
              await pool.query(
                `UPDATE crm_email_log
                    SET opened_at = $3
                  WHERE owner_id = $1
                    AND opened_at IS NULL
                    AND lower(subject) = lower($2)
                    AND EXISTS (SELECT 1 FROM unnest(to_addresses) t WHERE lower(t) = $4)`,
                [u.id, originalSubject, when, reader],
              );
            }
            try { await graph.fetch(`/me/messages/${encodeURIComponent(m.id)}`, { method: "PATCH", body: JSON.stringify({ isRead: true }) }); } catch { /* non-fatal */ }
          }
        } catch (err) {
          console.error("[readReceiptWorker] user scan failed:", err);
        }
      }
    } catch (err) {
      console.error("[readReceiptWorker] tick failed:", err);
    } finally {
      running = false;
    }
  };

  const timer = setInterval(() => { void tick(); }, TICK_MS);
  setTimeout(() => { void tick(); }, 15_000);
  return { stop: () => { stopped = true; clearInterval(timer); } };
}
