// BF_SERVER_UNIVERSAL_SUPPRESSION_v1 - Boreal Financial, Boreal Risk Management and Keystone share one SendGrid account,
// so SendGrid's own lists are copied into email_suppressions every hour: global unsubscribes (stop all email), spam
// reports and permanent bounces from any brand, and unsubscribes from Boreal Financial's own group. Unsubscribing from
// another brand's group does not stop Boreal Financial mail (BF_SERVER_BRAND_UNSUBSCRIBES_v1).
import { pool } from "../db.js";
import { logError } from "../observability/logger.js";

type Kind = { path: string; reason: string; keep?: (row: any) => boolean; brands?: string[] };
export const SUPPRESSION_KINDS: Kind[] = [
  { path: "/v3/suppression/unsubscribes", reason: "unsubscribe" },
  { path: "/v3/suppression/spam_reports", reason: "spamreport" },
  // only permanent bounces (5.x.x); a temporary one is no reason to stop writing to someone
  { path: "/v3/suppression/bounces", reason: "bounce", keep: (r) => /^5\./.test(String(r?.status ?? "5.")) },
  // BF_SERVER_BRAND_UNSUBSCRIBES_v1 - only Boreal Financial's own unsubscribe group: someone who unsubscribed from another
  // brand's group still gets Boreal Financial mail. A global unsubscribe (above) means stop all email, so it stays.
  { path: "/v3/asm/suppressions", reason: "group_unsubscribe", brands: ["BF"], keep: (r) => ownGroup() !== null && Number(r?.group_id) === ownGroup() },
];
const PAGE = 500;
function ownGroup(): number | null {
  const n = Number(process.env.SENDGRID_UNSUBSCRIBE_GROUP_ID ?? "");
  return Number.isFinite(n) && n > 0 ? n : null;
}

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
      `INSERT INTO email_suppressions (email, reason, source, brands)
       SELECT e, $2, 'sendgrid_list', $3::text[] FROM unnest($1::text[]) AS e
       ON CONFLICT (email) DO UPDATE SET brands = NULL, reason = EXCLUDED.reason
        WHERE EXCLUDED.brands IS NULL AND email_suppressions.brands IS NOT NULL`,
      [emails, kind.reason, kind.brands ?? null],
    );
    added += r.rowCount ?? 0;
  }
  if (added > 0) {
    await pool.query(
      `UPDATE contacts c SET marketing_opt_out = true, updated_at = now()
        WHERE c.marketing_opt_out = false AND EXISTS (
          SELECT 1 FROM email_suppressions s
           WHERE s.email IN (lower(trim(coalesce(c.email, ''))), lower(trim(coalesce(c.secondary_email, '')))) AND s.email <> ''
             AND (s.brands IS NULL OR coalesce(c.silo, 'BF') = ANY (s.brands)))`,
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
