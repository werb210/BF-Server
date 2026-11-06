// BF_SERVER_v903_YE26_TEMPLATES - the year-end 2026 write-off campaigns (twice-weekly to Canadian lenders, US lenders,
// referrers and clients; weekly to clients, lawyers, accountants and insurance brokers): 72 email templates in the BF
// silo's Marketing > Templates library, each with its own header image served from /api/public/email/ye26/.
// BI contacts get these same templates, sent as Boreal Financial, so nothing is seeded in BI.
//
// Insert-only by name: a template that already exists (including one staff have edited) is never touched, so this is
// safe on every start. NON-FATAL: a failure is logged and the server starts anyway.
import fs from "node:fs";
import path from "node:path";
import type { Pool } from "pg";
import { renderBrandedEmail, type BrandedEmailFields } from "../services/emailTemplateRender.js";

export type YearEndTemplate = {
  campaign: string; group: string; n: number; date: string; name: string; subject: string; preview: string;
  body: string; image: string; ctaLabel: string; ctaUrl: string;
};

export const YE26_DIR = path.join(process.cwd(), "assets", "email", "ye26");

export function loadYearEndTemplates(dir = YE26_DIR): YearEndTemplate[] {
  const file = path.join(dir, "templates.json");
  if (!fs.existsSync(file)) return [];
  return JSON.parse(fs.readFileSync(file, "utf8")) as YearEndTemplate[];
}

export function yearEndFields(t: YearEndTemplate, publicBase: string): BrandedEmailFields {
  const base = publicBase.replace(/\/+$/, "");
  return {
    headline: t.subject,
    heroUrl: `${base}/api/public/email/ye26/${t.image}`,
    heroLink: t.ctaUrl || "",
    body: t.body,
    ctaLabel: t.ctaLabel || "",
    ctaUrl: t.ctaUrl || "",
    image2Url: "", image2Link: "",
    headline2: "", body2: "", rightImageUrl: "", rightImageLink: "",
    cta2Label: "", cta2Url: "",
  };
}

export async function seedYearEndTemplates(
  pool: Pick<Pool, "query">,
  opts: { dir?: string; publicBase?: string; silo?: string } = {},
): Promise<{ total: number; inserted: number; skipped: number }> {
  const templates = loadYearEndTemplates(opts.dir);
  const base = opts.publicBase ?? (process.env.PUBLIC_SERVER_URL || "https://server.boreal.financial");
  const silo = opts.silo ?? "BF";
  let inserted = 0;
  let skipped = 0;
  for (const t of templates) {
    const exists = await pool.query(
      `SELECT 1 FROM marketing_template WHERE silo = $1 AND channel = 'email' AND name = $2 LIMIT 1`,
      [silo, t.name],
    );
    if (exists.rows.length) { skipped += 1; continue; }
    const fields = yearEndFields(t, base);
    await pool.query(
      `INSERT INTO marketing_template (silo, channel, name, body, link_url, subject, html, fields, created_by)
       VALUES ($1, 'email', $2, $3, NULL, $4, $5, $6::jsonb, 'ye26-seed')`,
      [silo, t.name, t.body, t.subject, renderBrandedEmail(fields), JSON.stringify(fields)],
    );
    inserted += 1;
  }
  return { total: templates.length, inserted, skipped };
}
