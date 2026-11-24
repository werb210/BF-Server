// BF_SERVER_SILO_SIGNATURES_v1 (2026-11-24) - a staff member keeps one personal signature per business: the Boreal
// Financial one (user_settings.email_signature_html, unchanged) and one for each other silo (Keystone, BI, SLF) in
// user_settings.email_signatures_by_silo. Sending from Keystone never falls back to the Boreal signature.
import { pool } from "../../db.js";

type Q = { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }> };

const norm = (silo: unknown) => String(silo ?? "BF").trim().toUpperCase() || "BF";

export async function personalSignatureHtml(userId: string, silo: unknown, db: Q = pool as any): Promise<string> {
  const s = norm(silo);
  const r = await db.query(
    `SELECT email_signature_html, coalesce(email_signatures_by_silo, '{}'::jsonb) AS by_silo FROM user_settings WHERE user_id = $1 LIMIT 1`,
    [userId],
  );
  const row = r.rows[0];
  if (!row) return "";
  if (s === "BF") return String(row.email_signature_html ?? "");
  return String(row.by_silo?.[s] ?? "");
}

export async function savePersonalSignatureHtml(userId: string, silo: unknown, html: string, db: Q = pool as any): Promise<void> {
  const s = norm(silo);
  const value = String(html ?? "").slice(0, 20000);
  if (s === "BF") {
    await db.query(
      `INSERT INTO user_settings (user_id, email_signature_html, updated_at) VALUES ($1, $2, now())
       ON CONFLICT (user_id) DO UPDATE SET email_signature_html = EXCLUDED.email_signature_html, updated_at = now()`,
      [userId, value],
    );
    return;
  }
  await db.query(
    `INSERT INTO user_settings (user_id, email_signatures_by_silo, updated_at) VALUES ($1, jsonb_build_object($2::text, $3::text), now())
     ON CONFLICT (user_id) DO UPDATE
       SET email_signatures_by_silo = coalesce(user_settings.email_signatures_by_silo, '{}'::jsonb) || jsonb_build_object($2::text, $3::text),
           updated_at = now()`,
    [userId, s, value],
  );
}
