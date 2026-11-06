// BF_SERVER_v903_YE26_TEMPLATES - the year-end 2026 write-off campaigns (twice-weekly to Canadian lenders, US lenders,
// referrers and clients; weekly to clients, lawyers, accountants and insurance brokers): 72 email templates in the BF
// silo's Marketing > Templates library, each with its own header image served from /api/public/email/ye26/.
// BI contacts get these same templates, sent as Boreal Financial, so nothing is seeded in BI.
//
// Insert-only by name: a template that already exists is left alone, so this is safe on every start. The one exception
// (BF_SERVER_v904_YE26_REFRESH): a template still exactly as seeded carries fields.ye26Version; when the text here is
// revised, those rows are refreshed. Saving a template in the composer drops ye26Version, so a staff edit is never
// overwritten. NON-FATAL: a failure is logged and the server starts anyway.
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Pool } from "pg";
import { renderBrandedEmail, type BrandedEmailFields } from "../services/emailTemplateRender.js";

export type YearEndTemplate = {
  campaign: string; group: string; n: number; date: string; name: string; subject: string; preview: string;
  body: string; image: string; ctaLabel: string; ctaUrl: string;
  /** BF_SERVER_v905_APP_LAUNCH - optional overrides: headline ("" = none), a second column with its own image and button. */
  extra?: { headline?: string; headline2?: string; body2?: string; rightImage?: string; rightImageLink?: string; cta2Label?: string; cta2Url?: string };
};

export const YE26_DIR = path.join(process.cwd(), "assets", "email", "ye26");
// Bump when templates.json changes. v2: Personal Guarantee Insurance described as the insurance partner requires.
export const YE26_VERSION = 2;

export function loadYearEndTemplates(dir = YE26_DIR): YearEndTemplate[] {
  const file = path.join(dir, "templates.json");
  if (!fs.existsSync(file)) return [];
  return JSON.parse(fs.readFileSync(file, "utf8")) as YearEndTemplate[];
}

/** SHA-256 of each v1 body (v903 seeded rows carry no version marker): an untouched v1 row matches its hash. */
function v1BodyHashes(dir = YE26_DIR): Record<string, string> {
  const file = path.join(dir, "v1-bodies.json");
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
}

export function yearEndFields(t: YearEndTemplate, publicBase: string, campaign = "ye26", version = YE26_VERSION): BrandedEmailFields & { ye26Version: number } {
  const base = publicBase.replace(/\/+$/, "");
  const x = t.extra ?? {};
  const img = (f?: string) => (f ? `${base}/api/public/email/${campaign}/${f}` : "");
  return {
    headline: x.headline ?? t.subject,
    heroUrl: img(t.image),
    heroLink: t.ctaUrl || "",
    body: t.body,
    ctaLabel: t.ctaLabel || "",
    ctaUrl: t.ctaUrl || "",
    image2Url: "", image2Link: "",
    headline2: x.headline2 ?? "", body2: x.body2 ?? "", rightImageUrl: img(x.rightImage), rightImageLink: x.rightImageLink ?? "",
    cta2Label: x.cta2Label ?? "", cta2Url: x.cta2Url ?? "",
    ye26Version: version,
  };
}

export async function seedYearEndTemplates(
  pool: Pick<Pool, "query">,
  opts: { dir?: string; publicBase?: string; silo?: string; campaign?: string; version?: number } = {},
): Promise<{ total: number; inserted: number; refreshed: number; skipped: number }> {
  const templates = loadYearEndTemplates(opts.dir);
  const base = opts.publicBase ?? (process.env.PUBLIC_SERVER_URL || "https://server.boreal.financial");
  const silo = opts.silo ?? "BF";
  const v1 = v1BodyHashes(opts.dir);
  const campaign = opts.campaign ?? "ye26";
  const version = opts.version ?? YE26_VERSION;
  let inserted = 0;
  let refreshed = 0;
  let skipped = 0;
  for (const t of templates) {
    const fields = yearEndFields(t, base, campaign, version);
    const exists = await pool.query(
      `SELECT id, fields->>'ye26Version' AS version, body, created_by FROM marketing_template
        WHERE silo = $1 AND channel = 'email' AND name = $2 ORDER BY updated_at DESC LIMIT 1`,
      [silo, t.name],
    );
    if (exists.rows.length) {
      const row = exists.rows[0] as { id: string; version: string | null; body?: string | null; created_by?: string | null };
      const seededV1 = (row.version === null || row.version === undefined) && row.created_by === `${campaign}-seed`
        && !!v1[t.name] && createHash("sha256").update(String(row.body ?? "")).digest("hex") === v1[t.name];
      const olderSeed = row.version !== null && row.version !== undefined && Number(row.version) < version;
      if (seededV1 || olderSeed) {
        await pool.query(
          `UPDATE marketing_template SET body = $2, subject = $3, html = $4, fields = $5::jsonb, link_url = NULL, updated_at = now()
            WHERE id = $1`,
          [row.id, t.body, t.subject, renderBrandedEmail(fields), JSON.stringify(fields)],
        );
        refreshed += 1;
      } else {
        skipped += 1;
      }
      continue;
    }
    await pool.query(
      `INSERT INTO marketing_template (silo, channel, name, body, link_url, subject, html, fields, created_by)
       VALUES ($1, 'email', $2, $3, NULL, $4, $5, $6::jsonb, $7)`,
      [silo, t.name, t.body, t.subject, renderBrandedEmail(fields), JSON.stringify(fields), `${campaign}-seed`],
    );
    inserted += 1;
  }
  return { total: templates.length, inserted, refreshed, skipped };
}

// BF_SERVER_v905_APP_LAUNCH - the client-app launch announcement (clients, with the draw) and Todd's note to lenders.
export const APP_LAUNCH_DIR = path.join(process.cwd(), "assets", "email", "applaunch");
export async function seedAppLaunchTemplates(pool: Pick<Pool, "query">, opts: { publicBase?: string; silo?: string } = {}) {
  return seedYearEndTemplates(pool, { ...opts, dir: APP_LAUNCH_DIR, campaign: "applaunch", version: 1 });
}
