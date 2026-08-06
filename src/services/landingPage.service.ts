// BF_SERVER_BLOCK_v780_PUBLIC_LANDING — render + persist a hosted landing page
// (mirror of the branded email) and resolve it by slug for the public route.
import { pool } from "../db.js";
import { renderBrandedEmail, type BrandedEmailFields } from "./emailTemplateRender.js";

// BF_SERVER_LANDING_BASE_HOST_v14
// LANDING_BASE_URL is not set on the App Service, so this fell back to the
// hardcoded apex - and the apex is NOT the Static Web App. Verified 2026-08-04:
//
//   https://www.boreal.financial/e/zzzz  -> 200, SPA renders
//   https://boreal.financial/e/zzzz      -> "Not Found" (405 on HEAD)
//
// The apex is fronted by something that serves the pages it knows and 404s
// everything else; only www runs the SWA with the navigationFallback that lets
// the /e/:slug route resolve. So every short link ever minted pointed at a host
// that cannot serve it.
//
// The default is now www, which is the host that actually works. Set
// LANDING_BASE_URL to override if the apex is ever pointed at the SWA.
// BF_SERVER_LANDING_BASE_GUARD_v24 - `|| fallback` only catches empty. The App
// Service was set with the SETTING NAME pasted into the value field, so
// LANDING_BASE_URL held the literal string "LANDING_BASE_URL" - truthy, so the
// fallback never fired and every minted link read "LANDING_BASE_URL/e/<slug>".
// A base that is not an absolute http(s) URL is garbage, not an override.
function landingBase(): string {
  const raw = String(process.env.LANDING_BASE_URL ?? "").trim();
  if (raw && /^https?:\/\/[^\s/]+/i.test(raw)) return raw.replace(/\/+$/, "");
  if (raw) {
    console.warn("[landing] ignoring invalid LANDING_BASE_URL", { value: raw });
  }
  return "https://www.boreal.financial";
}

function slugify(): string {
  return Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-4);
}

export async function createLandingPage(args: {
  fields: BrandedEmailFields;
  silo: string;
  title?: string | null;
  createdBy?: string | null;
}): Promise<{ slug: string; url: string }> {
  const html = renderBrandedEmail(args.fields);
  let slug = slugify();
  for (let i = 0; i < 3; i++) {
    const exists = await pool.query("SELECT 1 FROM marketing_landing_pages WHERE slug=$1", [slug]);
    if (exists.rowCount === 0) break;
    slug = slugify();
  }
  await pool.query(
    `INSERT INTO marketing_landing_pages (slug, silo, title, html, fields, created_by)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [slug, args.silo, args.title ?? null, html, JSON.stringify(args.fields), args.createdBy ?? null],
  );
  return { slug, url: `${landingBase()}/e/${slug}` };
}

export async function getLandingBySlug(slug: string): Promise<{ title: string | null; html: string } | null> {
  const r = await pool.query("SELECT title, html FROM marketing_landing_pages WHERE slug=$1 LIMIT 1", [slug]);
  if (r.rowCount === 0) return null;
  return { title: r.rows[0].title ?? null, html: String(r.rows[0].html) };
}

// BF_SERVER_BLOCK_v782_VIEW_IN_BROWSER — host an already-rendered email body as
// a landing page (the clean copy, no view-in-browser link on the page itself).
// BF_SERVER_LANDING_MERGE_STRIP_v27 - a landing page has no recipient, so merge
// tokens can never resolve there. They were stored raw and served raw, so the
// public page rendered a literal "{{first_name}}, your file may fit...".
// Tokens are removed rather than replaced with a placeholder: "there, your file"
// reads worse than no salutation at all. Removing a leading token leaves a
// dangling comma, so that is cleaned up and the next letter re-capitalised.
export function stripMergeFields(html: string): string {
  let out = html.replace(/\{\{\s*[a-z_]+\s*\}\}/gi, "");
  // ">, your file" -> ">Your file"
  out = out.replace(/>(\s*),\s*([a-z])/g, (_m, ws, ch) => ">" + ws + ch.toUpperCase());
  out = out.replace(/>(\s*),\s*/g, ">$1");
  // Mid-sentence removal leaves a double space ("Hi  and welcome").
  out = out.replace(/([^\s>])[ \t]{2,}(?=\S)/g, "$1 ");
  return out;
}

export async function createLandingPageFromHtml(
  html: string, silo: string, title?: string | null, createdBy?: string | null,
): Promise<{ slug: string; url: string }> {
  let slug = slugify();
  for (let i = 0; i < 3; i++) {
    const exists = await pool.query("SELECT 1 FROM marketing_landing_pages WHERE slug=$1", [slug]);
    if (exists.rowCount === 0) break;
    slug = slugify();
  }
  await pool.query(
    `INSERT INTO marketing_landing_pages (slug, silo, title, html, fields, created_by)
     VALUES ($1,$2,$3,$4,'{}'::jsonb,$5)`,
    [slug, silo, title ?? null, stripMergeFields(html), createdBy ?? null], // BF_SERVER_LANDING_MERGE_STRIP_v27
  );
  return { slug, url: `${landingBase()}/e/${slug}` };
}

// Inject a small "View in browser" link into a branded email. Anchors on the
// outer gray cell; if the template shape is unknown, returns html unchanged.
// BF_SERVER_TEMPLATE_SAVE_BY_NAME_v18 - re-saving a template under the same name
// rewrites the landing page IN PLACE, keeping the slug. Minting a new slug would
// leave every /e/ link already sent by SMS pointing at the superseded copy.
export async function updateLandingPageHtml(slug: string, html: string, title?: string | null): Promise<boolean> {
  const r = await pool.query(
    "UPDATE marketing_landing_pages SET html = $2, title = COALESCE($3, title) WHERE slug = $1",
    [slug, stripMergeFields(html), title ?? null], // BF_SERVER_LANDING_MERGE_STRIP_v27
  );
  return (r.rowCount ?? 0) > 0;
}

// BF_SERVER_LANDING_URL_REBUILD_v25 - always derive the public URL from the
// CURRENT base plus the slug. v18 reused the stored link_url on re-save, so a
// row written while LANDING_BASE_URL was misconfigured kept its broken URL
// forever - re-saving updated the page content but handed back the same bad
// string, which is exactly what it looked like from the composer.
export function landingUrlForSlug(slug: string): string {
  return `${landingBase()}/e/${slug}`;
}

export function slugFromLandingUrl(url: string | null | undefined): string | null {
  const m = /\/e\/([A-Za-z0-9_-]+)\s*$/.exec(String(url ?? "").trim());
  return m ? m[1] : null;
}

export function withViewInBrowser(html: string, url: string): string {
  const bar = `<div style="font-family:Arial,Helvetica,sans-serif;font-size:11px;color:#9ca3af;margin:0 0 12px;text-align:center;">Trouble viewing this email? <a href="${url}" style="color:#6b7280;">View it in your browser</a></div>`;
  const anchor = '<td align="center" style="padding:24px 12px;">';
  return html.includes(anchor) ? html.replace(anchor, anchor + bar) : html;
}
