// BF_SERVER_UNIVERSAL_SUPPRESSION_v1 - one do-not-email list for every business. Boreal Financial, Boreal Risk
// Management and Keystone share one SendGrid account, so SendGrid's own lists (global unsubscribes, spam reports,
// permanent bounces and unsubscribes from the email-preferences groups) are copied into email_suppressions every hour.
// Someone who unsubscribes from a Keystone or Boreal Risk Management email is then never emailed by a Boreal Financial
// flow either, whether or not the webhook event reached this server.
import { pool } from "../db.js";
import { logError } from "../observability/logger.js";

type Kind = { path: string; reason: string; keep?: (row: any) => boolean };
export const SUPPRESSION_KINDS: Kind[] = [
  { path: "/v3/suppression/unsubscribes", reason: "unsubscribe" },
  { path: "/v3/suppression/spam_reports", reason: "spamreport" },
  // only permanent bounces (5.x.x); a temporary one is no reason to stop writing to someone
  { path: "/v3/suppression/bounces", reason: "bounce", keep: (r) => /^5\./.test(String(r?.status ?? "5.")) },
  { path: "/v3/asm/suppressions", reason: "group_unsubscribe" },
];
const PAGE = 500;

export async function fetchSuppressed(apiKey: string, kind: Kind, fetchImpl: typeof fetch = fetch): Promise<string[]> {
  const out: string[] = [];
  for (let offset = 0; offset < 50_000; offset += PAGE) {
    const r = await fetchImpl(`https://api.sendgrid.com${kind.path}?limit=${PAGE}&offset=${offset}`, {
      headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
      signal: AbortSignal.timeout(30_000),
    });
    if (!r.ok) throw new Error(`sendgrid_${r.status}_${kind.reason}`);
    const rows = (await r.json()) as any[];
    if (!Array.isArray(rows)) break;
    for (const row of rows) {
      const email = String(row?.email ?? "").trim().toLowerCase();
      if (email && (!kind.keep || kind.keep(row))) out.push(email);
    }
    if (rows.length < PAGE) break;
  }
  return out;
}

export async function syncSendgridSuppressions(fetchImpl: typeof fetch = fetch): Promise<{ checked: number; added: number }> {
  const apiKey = process.env.SENDGRID_API_KEY;
  if (!apiKey) return { checked: 0, added: 0 };
  let checked = 0, added = 0;
  for (const kind of SUPPRESSION_KINDS) {
    const emails = Array.from(new Set(await fetchSuppressed(apiKey, kind, fetchImpl)));
    checked += emails.length;
    if (!emails.length) continue;
    const r = await pool.query(
      `INSERT INTO email_suppressions (email, reason, source)
       SELECT e, $2, 'sendgrid_list' FROM unnest($1::text[]) AS e
       ON CONFLICT (email) DO NOTHING`,
      [emails, kind.reason],
    );
    added += r.rowCount ?? 0;
  }
  if (added > 0) {
    await pool.query(
      `UPDATE contacts c SET marketing_opt_out = true, updated_at = now()
        WHERE c.marketing_opt_out = false AND EXISTS (
          SELECT 1 FROM email_suppressions s
           WHERE s.email IN (lower(trim(coalesce(c.email, ''))), lower(trim(coalesce(c.secondary_email, '')))) AND s.email <> '')`,
    );
  }
  return { checked, added };
}

export function startSendgridSuppressionSync(): { stop: () => void } {
  if (!process.env.SENDGRID_API_KEY) return { stop: () => undefined };
  const run = () => syncSendgridSuppressions().catch((err) => logError("sendgrid_suppression_sync_failed", { message: err?.message }));
  const first = setTimeout(run, 60_000);
  const timer = setInterval(run, 60 * 60_000);
  first.unref?.(); timer.unref?.();
  return { stop: () => { clearTimeout(first); clearInterval(timer); } };
}
