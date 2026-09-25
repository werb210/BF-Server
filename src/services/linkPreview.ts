// BF_SERVER_BLOCK_v504_TEAM_LINK_PREVIEWS
// Fetch a page's title/description/image for a Team chat link preview. The
// fetch runs on the server (the browser would be blocked by CORS), so it must
// never reach an internal address: every hop's host is resolved and private,
// loopback, link-local and metadata ranges are refused. Redirects are followed
// by hand (max 3) so each hop is checked. 5 s timeout, 512 KB read cap.
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { pool } from "../db.js";

export type LinkPreview = { url: string; ok: boolean; title: string | null; description: string | null; imageUrl: string | null; siteName: string | null };

export function isPublicAddress(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) {
    const [a, b] = ip.split(".").map(Number);
    if (a === 10 || a === 127 || a === 0) return false;
    if (a === 169 && b === 254) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && b === 168) return false;
    if (a === 100 && b >= 64 && b <= 127) return false;
    if (a >= 224) return false;
    return true;
  }
  if (v === 6) {
    const x = ip.toLowerCase();
    if (x === "::1" || x === "::") return false;
    if (x.startsWith("fc") || x.startsWith("fd") || x.startsWith("fe80")) return false;
    if (x.startsWith("::ffff:")) return isPublicAddress(x.slice(7));
    return true;
  }
  return false;
}

function decode(s: string): string {
  return s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\s+/g, " ").trim();
}

function meta(html: string, key: string): string | null {
  const re = new RegExp(`<meta[^>]+(?:property|name)=["']${key}["'][^>]*>`, "i");
  const tag = html.match(re)?.[0];
  if (!tag) return null;
  const c = tag.match(/content=["']([^"']*)["']/i)?.[1];
  return c ? decode(c).slice(0, 500) : null;
}

export function parsePreview(url: string, html: string): LinkPreview {
  const title = meta(html, "og:title") ?? meta(html, "twitter:title") ?? (html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1] ? decode(html.match(/<title[^>]*>([^<]*)<\/title>/i)![1]).slice(0, 300) : null);
  const description = meta(html, "og:description") ?? meta(html, "description") ?? meta(html, "twitter:description");
  let imageUrl = meta(html, "og:image") ?? meta(html, "twitter:image");
  if (imageUrl) { try { imageUrl = new URL(imageUrl, url).toString(); } catch { imageUrl = null; } }
  if (imageUrl && !/^https:\/\//i.test(imageUrl)) imageUrl = null;
  const siteName = meta(html, "og:site_name") ?? (() => { try { return new URL(url).hostname; } catch { return null; } })();
  return { url, ok: Boolean(title || description), title, description, imageUrl, siteName };
}

async function assertPublicHost(u: URL): Promise<void> {
  if (!/^https?:$/.test(u.protocol)) throw new Error("scheme_not_allowed");
  if (u.port && !["80", "443"].includes(u.port)) throw new Error("port_not_allowed");
  const host = u.hostname.replace(/^\[|\]$/g, "");
  const addrs = isIP(host) ? [{ address: host }] : await lookup(host, { all: true });
  if (!addrs.length || addrs.some((a) => !isPublicAddress(a.address))) throw new Error("address_not_public");
}

export async function fetchPreview(rawUrl: string): Promise<LinkPreview> {
  let current = new URL(rawUrl);
  for (let hop = 0; hop < 4; hop++) {
    await assertPublicHost(current);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 5000);
    try {
      const resp = await fetch(current, { redirect: "manual", signal: ctrl.signal, headers: { "User-Agent": "BorealLinkPreview/1.0", Accept: "text/html" } });
      if (resp.status >= 300 && resp.status < 400) {
        const loc = resp.headers.get("location");
        if (!loc) break;
        current = new URL(loc, current);
        continue;
      }
      if (!resp.ok || !/text\/html/i.test(resp.headers.get("content-type") ?? "")) break;
      const reader = resp.body?.getReader();
      if (!reader) break;
      const chunks: Uint8Array[] = [];
      let size = 0;
      while (size < 512 * 1024) {
        const { done, value } = await reader.read();
        if (done || !value) break;
        chunks.push(value);
        size += value.length;
      }
      await reader.cancel().catch(() => undefined);
      return parsePreview(current.toString(), Buffer.concat(chunks).toString("utf8"));
    } finally {
      clearTimeout(timer);
    }
  }
  return { url: rawUrl, ok: false, title: null, description: null, imageUrl: null, siteName: null };
}

/** Cached for 7 days (failures for 1 day). */
export async function getLinkPreview(rawUrl: string): Promise<LinkPreview> {
  const cached = await pool.query<{ ok: boolean; title: string | null; description: string | null; image_url: string | null; site_name: string | null; fresh: boolean }>(
    `SELECT ok, title, description, image_url, site_name,
            fetched_at > NOW() - (CASE WHEN ok THEN interval '7 days' ELSE interval '1 day' END) AS fresh
       FROM link_previews WHERE url = $1`, [rawUrl]);
  const row = cached.rows[0];
  if (row?.fresh) return { url: rawUrl, ok: row.ok, title: row.title, description: row.description, imageUrl: row.image_url, siteName: row.site_name };
  let p: LinkPreview;
  try { p = await fetchPreview(rawUrl); }
  catch (err: any) {
    console.warn("[link-preview] fetch refused or failed", { url: rawUrl, error: err?.message ?? String(err) });
    p = { url: rawUrl, ok: false, title: null, description: null, imageUrl: null, siteName: null };
  }
  await pool.query(
    `INSERT INTO link_previews (url, ok, title, description, image_url, site_name, fetched_at)
     VALUES ($1,$2,$3,$4,$5,$6,NOW())
     ON CONFLICT (url) DO UPDATE SET ok=EXCLUDED.ok, title=EXCLUDED.title, description=EXCLUDED.description,
       image_url=EXCLUDED.image_url, site_name=EXCLUDED.site_name, fetched_at=NOW()`,
    [rawUrl, p.ok, p.title, p.description, p.imageUrl, p.siteName],
  ).catch((err: any) => console.warn("[link-preview] cache write failed", { url: rawUrl, error: err?.message ?? String(err) }));
  return p;
}
