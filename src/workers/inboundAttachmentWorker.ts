// BF_INBOUND_ATTACHMENT_WORKER_v1
// Auto-files inbound email attachments to the CRM. Every few minutes it scans each connected
// user's inbox for recent messages that have attachments and files them to the matching (or
// newly created) contact in that user's silo, reusing fileInboundAttachments. Idempotent: a
// message already represented in contact_documents is skipped before any download, and the DB
// insert dedupes on (silo, source_message_id, filename).
import type { Pool } from "pg";
import { getGraphForUser, type GraphClient } from "../modules/o365/graphClient.js";
import { fileInboundAttachments } from "../services/contactDocuments.js";

// BF_INBOUND_ATTACHMENT_ATTEMPT_LEDGER_v189
// A message that files nothing writes no contact_documents row, so the old
// pre-check never matched it and the worker re-downloaded it every 5 minutes for
// two days. Cap the attempts instead.
const MAX_ATTEMPTS = 3;

async function shouldSkipMessage(pool: Pool, silo: string, messageId: string): Promise<boolean> {
  try {
    const { rows } = await pool.query<{ attempts: number; last_outcome: string | null }>(
      `SELECT attempts, last_outcome FROM inbound_attachment_attempts
        WHERE silo = $1 AND message_id = $2`,
      [silo, messageId],
    );
    const row = rows[0];
    if (!row) return false;
    if (row.last_outcome === "filed" || row.last_outcome === "terminal") return true;
    return Number(row.attempts ?? 0) >= MAX_ATTEMPTS;
  } catch {
    return false; // ledger unavailable -> behave as before
  }
}

async function recordAttempt(pool: Pool, silo: string, messageId: string, outcome: string): Promise<void> {
  try {
    await pool.query(
      `INSERT INTO inbound_attachment_attempts (silo, message_id, attempts, last_outcome, last_attempt_at)
       VALUES ($1, $2, 1, $3, now())
       ON CONFLICT (silo, message_id) DO UPDATE
         SET attempts = inbound_attachment_attempts.attempts + 1,
             last_outcome = EXCLUDED.last_outcome,
             last_attempt_at = now()`,
      [silo, messageId, outcome],
    );
  } catch {
    /* ledger write failure must never break the scan */
  }
}

const INTERVAL_MS = 5 * 60 * 1000; // poll every 5 minutes
const LOOKBACK_MS = 2 * 24 * 60 * 60 * 1000; // only consider mail from the last 2 days
const INITIAL_DELAY_MS = 30 * 1000; // let startup settle before the first pass

// BF_INBOUND_ATTACHMENT_SHARED_MAILBOX_v1 - app-only (client-credentials) Graph token, used to
// read shared mailboxes (info@, submissions@, ...). Requires the Mail.Read APPLICATION permission
// on the "Boreal Financial Server" app registration; without it the mailbox reads 403 and we skip.
let appToken: { token: string; expiresAt: number } | null = null;
async function getAppOnlyToken(): Promise<string | null> {
  if (appToken && appToken.expiresAt > Date.now() + 60000) return appToken.token;
  const tenant = process.env.MS_GRAPH_TENANT_ID ?? "";
  const clientId = process.env.MS_GRAPH_CLIENT_ID ?? "";
  const clientSecret = process.env.MS_GRAPH_CLIENT_SECRET ?? "";
  if (!tenant || !clientId || !clientSecret) return null;
  try {
    const url = `https://login.microsoftonline.com/${encodeURIComponent(tenant)}/oauth2/v2.0/token`;
    const body = new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: "client_credentials",
      scope: "https://graph.microsoft.com/.default",
    });
    const resp = await fetch(url, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body });
    if (!resp.ok) return null;
    const json = (await resp.json()) as { access_token?: string; expires_in?: number };
    const token = String(json.access_token ?? "");
    if (!token) return null;
    appToken = { token, expiresAt: Date.now() + Number(json.expires_in ?? 3600) * 1000 };
    return token;
  } catch {
    return null;
  }
}
function appGraph(token: string): GraphClient {
  return {
    accessToken: token,
    fetch: (path: string, init?: RequestInit) =>
      fetch(`https://graph.microsoft.com/v1.0${path}`, {
        ...(init ?? {}),
        headers: { ...((init?.headers as Record<string, string>) ?? {}), Authorization: `Bearer ${token}` },
      }),
  };
}

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
          // BF_INBOUND_ATTACHMENT_ATTEMPT_LEDGER_v189
          if (await shouldSkipMessage(pool, silo, mid)) continue;
          try {
            const res = await fileInboundAttachments({ pool, graph, base: "/me", message: m, silo, ownerId: u.id });
            const outcome = (res.filed ?? 0) > 0 ? "filed" : res.retryable ? "retryable" : "terminal";
            await recordAttempt(pool, silo, mid, outcome);
          } catch {
            await recordAttempt(pool, silo, mid, "retryable");
          }
        }
      }

      // BF_INBOUND_ATTACHMENT_SHARED_MAILBOX_v1 - also scan shared mailboxes via app-only Graph,
      // filing each to the mailbox's configured silo. Skips silently if app-only auth is
      // unavailable or a mailbox read is forbidden (no Mail.Read application permission yet).
      try {
        const { rows: boxes } = await pool.query<{ address: string; silo: string | null }>(
          `SELECT address, silo FROM shared_mailbox_settings WHERE COALESCE(address, '') <> ''`,
        );
        if (boxes.length) {
          const token = await getAppOnlyToken();
          if (token) {
            const graph = appGraph(token);
            for (const b of boxes) {
              if (stopped) break;
              const addr = String(b.address || "").trim();
              if (!addr) continue;
              const silo = b.silo || "BF";
              let r: Response;
              try {
                r = await graph.fetch(
                  `/users/${encodeURIComponent(addr)}/mailFolders/inbox/messages`
                    + `?$filter=hasAttachments eq true and receivedDateTime ge ${sinceIso}`
                    + `&$select=id,from,hasAttachments&$top=50`,
                );
              } catch {
                continue;
              }
              if (!r.ok) continue; // 403 (no Mail.Read app perm), 404, etc.
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
                  if (ex.length) continue;
                } catch {
                  /* fall through; insert still dedupes */
                }
                // BF_INBOUND_ATTACHMENT_ATTEMPT_LEDGER_v189
                if (await shouldSkipMessage(pool, silo, mid)) continue;
                try {
                  const res = await fileInboundAttachments({ pool, graph, base: `/users/${encodeURIComponent(addr)}`, message: m, silo });
                  const outcome = (res.filed ?? 0) > 0 ? "filed" : res.retryable ? "retryable" : "terminal";
                  await recordAttempt(pool, silo, mid, outcome);
                } catch {
                  await recordAttempt(pool, silo, mid, "retryable");
                }
              }
            }
          }
        }
      } catch {
        /* shared-mailbox pass is best-effort */
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
