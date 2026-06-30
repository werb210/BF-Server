// BF_SERVER_BLOCK_v780_PUBLIC_LANDING — render + persist a hosted landing page
// (mirror of the branded email) and resolve it by slug for the public route.
import { pool } from "../db.js";
import { renderBrandedEmail, type BrandedEmailFields } from "./emailTemplateRender.js";

function landingBase(): string {
  return (process.env.LANDING_BASE_URL || "https://boreal.financial").replace(/\/+$/, "");
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
