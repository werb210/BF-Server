// BF_SERVER_v951_SOCIAL_LINK_PREVIEW - the picture and headline of a linked article, for a social post.
// The address is typed by staff, so it is fetched with the same guard as every other user-entered address: public
// HTTPS hosts only, private and internal addresses refused at connect time, at most three redirects (each checked),
// two megabytes, eight seconds.
import { lenderHttp, type HttpClient } from "../lenderConnectors/http.js";
import { checkUrlShape } from "../lenderConnectors/ssrf.js";

export type LinkPreview = { url: string; title: string | null; description: string | null; image_url: string | null; site: string | null };

const decode = (s: string): string => s.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#0*39;|&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16))).replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d))).replace(/\s+/g, " ").trim();

/** Every <meta> tag as [name-or-property, content], whatever order its attributes are written in. */
export function metaTags(html: string): Map<string, string> {
  const out = new Map<string, string>();
  const head = html.slice(0, 600_000);
  for (const m of head.matchAll(/<meta\b[^>]*>/gi)) {
    const tag = m[0];
    const attr = (n: string): string | null => { const a = new RegExp(`\\b${n}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s"'>]+))`, "i").exec(tag); return a ? (a[2] ?? a[3] ?? a[4] ?? "") : null; };
    const key = (attr("property") ?? attr("name") ?? "").toLowerCase();
    const content = attr("content");
    if (key && content && !out.has(key)) out.set(key, decode(content));
  }
  return out;
}

export function previewFromHtml(html: string, pageUrl: string): LinkPreview {
  const meta = metaTags(html);
  const pick = (...keys: string[]): string | null => { for (const k of keys) { const v = meta.get(k); if (v) return v; } return null; };
  const titleTag = /<title[^>]*>([\s\S]{0,400}?)<\/title>/i.exec(html)?.[1];
  let image = pick("og:image:secure_url", "og:image", "og:image:url", "twitter:image", "twitter:image:src");
  if (image) {
    try { const abs = new URL(image, pageUrl); image = abs.protocol === "https:" && checkUrlShape(abs.toString()).ok ? abs.toString() : null; } catch { image = null; }
  }
  const cut = (s: string | null, n: number) => (s ? s.slice(0, n) : null);
  return {
    url: pageUrl,
    title: cut(pick("og:title", "twitter:title") ?? (titleTag ? decode(titleTag) : null), 300),
    description: cut(pick("og:description", "twitter:description", "description"), 500),
    image_url: image,
    site: cut(pick("og:site_name"), 120),
  };
}

export class LinkPreviewError extends Error { constructor(message: string, readonly status = 422) { super(message); } }

export async function fetchLinkPreview(raw: string, http: HttpClient = lenderHttp()): Promise<LinkPreview> {
  let current = String(raw ?? "").trim();
  for (let hop = 0; hop < 4; hop += 1) {
    const shape = checkUrlShape(current);
    if (!shape.ok) throw new LinkPreviewError("Enter a public link that starts with https://.", 400);
    let res;
    try {
      res = await http({ method: "GET", url: shape.url.toString(), timeoutMs: 8000, headers: { Accept: "text/html,application/xhtml+xml", "User-Agent": "Mozilla/5.0 (compatible; LinkPreview/1.0)" } });
    } catch (err) {
      console.warn("[social] link preview fetch failed", { host: shape.url.hostname, message: err instanceof Error ? err.message : String(err) });
      throw new LinkPreviewError("That page could not be reached, so its picture could not be read. You can still add a picture yourself.");
    }
    if (res.status >= 300 && res.status < 400 && res.headers.location) {
      try { current = new URL(res.headers.location, shape.url).toString(); } catch { throw new LinkPreviewError("That link redirects somewhere that could not be followed."); }
      continue;
    }
    if (res.status < 200 || res.status >= 300) throw new LinkPreviewError("That page did not open (it answered " + res.status + "), so its picture could not be read. You can still add a picture yourself.");
    if (!/html/i.test(res.headers["content-type"] ?? "text/html")) throw new LinkPreviewError("That link is not a web page, so there is no picture to read from it.");
    return previewFromHtml(res.text, shape.url.toString());
  }
  throw new LinkPreviewError("That link redirects too many times.");
}
