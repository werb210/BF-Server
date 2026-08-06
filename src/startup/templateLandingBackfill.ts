// BF_SERVER_TEMPLATE_LANDING_BACKFILL_v28
// Two defects this repairs, both left open by v24/v25.
//
// 1. v25 rebuilds link_url from the current LANDING_BASE_URL, but only inside
//    POST /api/marketing/templates. Rows written while the App Service held the
//    literal string "LANDING_BASE_URL" keep that value until someone happens to
//    re-save. The composer showed "LANDING_BASE_URL/e/<slug>" indefinitely.
//
// 2. The Aug 6 seed migrations insert fields only - html and link_url are NULL,
//    because SQL cannot call renderBrandedEmail. The save handler mints a
//    landing page only when the request carries html, so a seeded template had
//    no landing page and the composer hid the URL box entirely.
//
// Both are fixed here at startup instead of by hand: render the stored fields,
// mint (or repair) the page, write html + link_url back.
//
// NON-FATAL by design. A migration failure crash-loops the App Service; this is
// cosmetic repair and must never take the process down.
import type { Pool } from "pg";
import { renderBrandedEmail, type BrandedEmailFields } from "../services/emailTemplateRender.js";
import {
  createLandingPageFromHtml,
  updateLandingPageHtml,
  slugFromLandingUrl,
  landingUrlForSlug,
} from "../services/landingPage.service.js";

// Mirrors landingBase()'s validity test. A base that is not an absolute http(s)
// URL is garbage, and so is any link_url built on top of one.
export function isAbsoluteHttpUrl(value: string | null | undefined): boolean {
  return /^https?:\/\/[^\s/]+/i.test(String(value ?? "").trim());
}

export type TemplateRow = {
  id: string;
  silo: string;
  name: string | null;
  subject: string | null;
  html: string | null;
  link_url: string | null;
  fields: unknown;
};

// A row needs work when its URL is unusable, when it has no URL at all, or when
// it has fields but no rendered html to host.
export function needsLandingBackfill(row: TemplateRow): boolean {
  const hasFields = Boolean(row.fields && typeof row.fields === "object");
  const hasHtml = Boolean(row.html && String(row.html).trim());
  if (!hasFields && !hasHtml) return false;
  if (!row.link_url || !String(row.link_url).trim()) return true;
  return !isAbsoluteHttpUrl(row.link_url);
}

export async function backfillTemplateLandingPages(pool: Pool): Promise<{ scanned: number; repaired: number }> {
  const { rows } = await pool.query<TemplateRow>(
    `SELECT id, silo, name, subject, html, link_url, fields
       FROM marketing_template
      WHERE channel = 'email'
      ORDER BY updated_at DESC
      LIMIT 200`,
  );

  let repaired = 0;
  for (const row of rows) {
    if (!needsLandingBackfill(row)) continue;
    try {
      // Prefer stored html; fall back to rendering the composer fields. A seeded
      // row has fields and no html, which is the case that produced no page.
      let html = row.html && String(row.html).trim() ? String(row.html) : "";
      if (!html && row.fields && typeof row.fields === "object") {
        html = renderBrandedEmail(row.fields as BrandedEmailFields);
      }
      if (!html) continue;

      const title = String(row.subject || row.name || "Boreal");
      const silo = String(row.silo || "BF");

      // Keep the slug when there is a usable one - links already sent by SMS
      // must stay live and point at the current copy.
      const priorSlug = slugFromLandingUrl(row.link_url);
      let url: string;
      if (priorSlug && (await updateLandingPageHtml(priorSlug, html, title))) {
        url = landingUrlForSlug(priorSlug);
      } else {
        const lp = await createLandingPageFromHtml(html, silo, title, null);
        url = lp.url;
      }

      await pool.query(
        `UPDATE marketing_template
            SET html = COALESCE(NULLIF($2, ''), html),
                link_url = $3,
                updated_at = now()
          WHERE id = $1`,
        [row.id, html, url],
      );
      repaired += 1;
      console.log(JSON.stringify({ event: "template_landing_backfilled", id: row.id, name: row.name, url }));
    } catch (err) {
      console.error(JSON.stringify({
        event: "template_landing_backfill_failed",
        id: row.id,
        error: err instanceof Error ? err.message : String(err),
      }));
    }
  }
  return { scanned: rows.length, repaired };
}
