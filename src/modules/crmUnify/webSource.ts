// BF_SERVER_v856_CRM_UNIFY - fetch a company's own website for the AI summary, safely (no SSRF).
//   - http and https only, ports 80/443 only, no credentials in the URL, no IP-literal hosts.
//   - Every DNS answer is checked and the connection is made to the checked address itself (the lookup hook below),
//     so a second DNS answer cannot point the request somewhere private (DNS rebinding).
//   - Private, loopback, link-local, CGNAT, multicast, reserved and documentation ranges are refused, IPv4 and IPv6
//     (including IPv4-mapped and NAT64 forms).
//   - Redirects are followed by hand (max 3) and every hop goes through the same checks.
//   - 8 second total time limit, 1.5 MB size limit, text/html or text/plain only.
import http from "node:http";
import https from "node:https";
import dns from "node:dns";
import net from "node:net";

export const FREE_EMAIL_DOMAINS: ReadonlySet<string> = new Set([
  "gmail.com", "googlemail.com", "outlook.com", "outlook.ca", "hotmail.com", "hotmail.ca", "hotmail.co.uk", "live.com",
  "live.ca", "msn.com", "yahoo.com", "yahoo.ca", "yahoo.co.uk", "ymail.com", "rocketmail.com", "icloud.com", "me.com",
  "mac.com", "aol.com", "proton.me", "protonmail.com", "protonmail.ch", "pm.me", "shaw.ca", "telus.net", "telusplanet.net",
  "rogers.com", "sympatico.ca", "bell.net", "bellnet.ca", "videotron.ca", "cogeco.ca", "eastlink.ca", "sasktel.net",
  "mts.net", "gmx.com", "gmx.net", "mail.com", "yandex.com", "zoho.com", "zohomail.com", "fastmail.com", "hey.com",
  "tutanota.com", "comcast.net", "verizon.net", "att.net", "sbcglobal.net", "cox.net", "charter.net", "earthlink.net",
  "juno.com", "qq.com", "163.com", "naver.com",
]);

export function isFreeEmailDomain(domain: string): boolean {
  return FREE_EMAIL_DOMAINS.has(String(domain ?? "").trim().toLowerCase());
}

/** The website to read: the website field, else the domain of a work (not free) email. Null when neither. */
export function websiteFor(website: unknown, emails: unknown[]): { url: string; host: string; from: "website" | "email" } | null {
  const raw = String(website ?? "").trim();
  if (raw) {
    try {
      const u = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
      const host = u.hostname.toLowerCase().replace(/^www\./, "");
      if (host.includes(".") && !net.isIP(host)) return { url: `https://${u.hostname.toLowerCase()}${u.pathname === "/" ? "/" : u.pathname}`, host, from: "website" };
    } catch { /* not a URL: try the emails */ }
  }
  for (const e of emails) {
    const m = /@([a-z0-9.-]+\.[a-z]{2,})\s*$/i.exec(String(e ?? "").trim());
    const domain = m?.[1]?.toLowerCase();
    if (domain && !isFreeEmailDomain(domain)) return { url: `https://${domain}/`, host: domain, from: "email" };
  }
  return null;
}

function v4Blocked(ip: string): boolean {
  const p = ip.split(".").map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a, b, c] = p as [number, number, number, number];
  return a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0 && (c === 0 || c === 2)) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113);
}

function expandV6(ip: string): number[] | null {
  let s = (ip.toLowerCase().split("%")[0] ?? "").trim();
  const v4 = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(s);
  if (v4) {
    const q = v4.slice(1, 5).map(Number);
    if (q.some((n) => n > 255)) return null;
    s = s.slice(0, s.length - v4[0].length) + ((q[0]! << 8) | q[1]!).toString(16) + ":" + ((q[2]! << 8) | q[3]!).toString(16);
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const back = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const fill = halves.length === 2 ? 8 - head.length - back.length : 0;
  if (fill < 0 || (halves.length === 1 && head.length !== 8)) return null;
  const groups = [...head, ...Array(fill).fill("0"), ...back];
  if (groups.length !== 8 || groups.some((x) => !/^[0-9a-f]{1,4}$/.test(x))) return null;
  return groups.map((x) => parseInt(x, 16));
}

/** True when the address must never be fetched from the server. */
export function isBlockedAddress(ip: string): boolean {
  const kind = net.isIP(ip);
  if (kind === 4) return v4Blocked(ip);
  if (kind !== 6) return true;
  const g = expandV6(ip);
  if (!g) return true;
  const embedded = () => `${g[6]! >> 8}.${g[6]! & 255}.${g[7]! >> 8}.${g[7]! & 255}`;
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) return v4Blocked(embedded()); // ::ffff:a.b.c.d
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) return v4Blocked(embedded()); // NAT64
  if (g.every((x) => x === 0)) return true; // ::
  if (g.slice(0, 7).every((x) => x === 0) && g[7] === 1) return true; // ::1
  if (g.slice(0, 6).every((x) => x === 0)) return true; // IPv4-compatible (deprecated)
  const first = g[0]!;
  if ((first & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
  if ((first & 0xffc0) === 0xfe80) return true; // fe80::/10 link local
  if ((first & 0xffc0) === 0xfec0) return true; // fec0::/10 site local
  if ((first & 0xff00) === 0xff00) return true; // multicast
  if (first === 0x2001 && g[1] === 0x0db8) return true; // documentation
  if (first === 0x2002) return v4Blocked(`${g[1]! >> 8}.${g[1]! & 255}.${g[2]! >> 8}.${g[2]! & 255}`); // 6to4
  return false;
}

const BLOCKED_HOST_RE = /(^|\.)(localhost|local|localdomain|internal|intranet|lan|home|corp|arpa)$/i;

export type LookupFn = (host: string, opts: { all: true }, cb: (err: NodeJS.ErrnoException | null, addresses: Array<{ address: string; family: number }>) => void) => void;

export type SafeFetchOptions = {
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
  ports?: number[];
  lookup?: LookupFn;
  isAllowedAddress?: (ip: string) => boolean;
};

export type SafeFetchResult = { ok: true; url: string; status: number; contentType: string; body: string } | { ok: false; url: string; error: string };

export function checkUrl(raw: string, ports: number[]): { ok: true; url: URL } | { ok: false; error: string } {
  let u: URL;
  try { u = new URL(raw); } catch { return { ok: false, error: "bad_url" }; }
  if (u.protocol !== "http:" && u.protocol !== "https:") return { ok: false, error: "scheme_not_allowed" };
  if (u.username || u.password) return { ok: false, error: "credentials_not_allowed" };
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (!host || net.isIP(host)) return { ok: false, error: "ip_literal_not_allowed" };
  if (!host.includes(".") || BLOCKED_HOST_RE.test(host)) return { ok: false, error: "host_not_allowed" };
  const port = u.port ? Number(u.port) : u.protocol === "https:" ? 443 : 80;
  if (!ports.includes(port)) return { ok: false, error: "port_not_allowed" };
  return { ok: true, url: u };
}

function guardedLookup(base: LookupFn, allowed: (ip: string) => boolean) {
  return (hostname: string, options: any, callback: any) => {
    const cb = typeof options === "function" ? options : callback;
    base(hostname, { all: true }, (err, addresses) => {
      if (err) return cb(err);
      const list = Array.isArray(addresses) ? addresses : [];
      if (!list.length || !list.every((a) => allowed(a.address))) {
        const e: NodeJS.ErrnoException = new Error("blocked_address");
        e.code = "EBLOCKED";
        return cb(e);
      }
      const wantsAll = typeof options === "object" && options && options.all;
      if (wantsAll) return cb(null, list);
      return cb(null, list[0]!.address, list[0]!.family);
    });
  };
}

function oneRequest(u: URL, opts: Required<Omit<SafeFetchOptions, "ports">>, deadline: number):
  Promise<{ status: number; location: string | null; contentType: string; body: string }> {
  return new Promise((resolve, reject) => {
    const mod = u.protocol === "https:" ? https : http;
    const remaining = Math.max(1, deadline - Date.now());
    const req = mod.request(u, {
      method: "GET",
      lookup: guardedLookup(opts.lookup, opts.isAllowedAddress) as any,
      headers: { "user-agent": "BorealCRM/1.0 (+https://boreal.financial)", accept: "text/html,text/plain;q=0.9" },
      timeout: remaining,
    }, (res) => {
      const status = res.statusCode ?? 0;
      const location = typeof res.headers.location === "string" ? res.headers.location : null;
      const contentType = String(res.headers["content-type"] ?? "");
      if (status >= 300 && status < 400) { res.resume(); return resolve({ status, location, contentType, body: "" }); }
      const chunks: Buffer[] = [];
      let size = 0;
      res.on("data", (c: Buffer) => {
        size += c.length;
        if (size > opts.maxBytes) {
          const keep = c.subarray(0, Math.max(0, c.length - (size - opts.maxBytes)));
          if (keep.length) chunks.push(keep);
          req.destroy();
          resolve({ status, location, contentType, body: Buffer.concat(chunks).toString("utf8") });
          return;
        }
        chunks.push(c);
      });
      res.on("end", () => resolve({ status, location, contentType, body: Buffer.concat(chunks).toString("utf8") }));
      res.on("error", reject);
    });
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
    req.end();
  });
}

export async function safeFetchText(rawUrl: string, options: SafeFetchOptions = {}): Promise<SafeFetchResult> {
  const opts = {
    timeoutMs: options.timeoutMs ?? 8000,
    maxBytes: options.maxBytes ?? 1_500_000,
    maxRedirects: options.maxRedirects ?? 3,
    lookup: options.lookup ?? (dns.lookup as unknown as LookupFn),
    isAllowedAddress: options.isAllowedAddress ?? ((ip: string) => !isBlockedAddress(ip)),
  };
  const ports = options.ports ?? [80, 443];
  const deadline = Date.now() + opts.timeoutMs;
  let current = rawUrl;
  for (let hop = 0; hop <= opts.maxRedirects; hop++) {
    const checked = checkUrl(current, ports);
    if (!checked.ok) return { ok: false, url: current, error: checked.error };
    if (Date.now() >= deadline) return { ok: false, url: current, error: "timeout" };
    let r;
    try {
      r = await oneRequest(checked.url, opts, deadline);
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      return { ok: false, url: current, error: e?.code === "EBLOCKED" || /blocked_address/.test(String(e?.message)) ? "blocked_address" : e?.message === "timeout" ? "timeout" : "fetch_failed" };
    }
    if (r.status >= 300 && r.status < 400) {
      if (!r.location) return { ok: false, url: current, error: "redirect_without_location" };
      current = new URL(r.location, checked.url).toString();
      continue;
    }
    if (r.status < 200 || r.status >= 300) return { ok: false, url: current, error: `http_${r.status}` };
    if (!/^text\/(html|plain)/i.test(r.contentType.trim()) && r.contentType.trim() !== "") return { ok: false, url: current, error: "not_text" };
    return { ok: true, url: current, status: r.status, contentType: r.contentType, body: r.body };
  }
  return { ok: false, url: current, error: "too_many_redirects" };
}

/** Readable text of an HTML page: title, meta description, then the body without scripts, styles and navigation. */
export function pageText(html: string, max = 6000): string {
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? "";
  const description = /<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)["']/i.exec(html)?.[1] ?? "";
  const body = html
    .replace(/<(script|style|noscript|svg|nav|footer|header|form)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, "\"")
    .replace(/\s+/g, " ").trim();
  return [title.trim(), description.trim(), body].filter(Boolean).join("\n").slice(0, max);
}

/** The homepage text of a domain (https first, then http), or null. */
export async function fetchSiteText(domain: string, options: SafeFetchOptions = {}): Promise<{ url: string; text: string } | null> {
  for (const scheme of ["https", "http"]) {
    const r = await safeFetchText(`${scheme}://${domain}/`, options);
    if (r.ok) {
      const text = /html/i.test(r.contentType) || /<html/i.test(r.body) ? pageText(r.body) : r.body.slice(0, 6000);
      return text ? { url: r.url, text } : null;
    }
    if (r.error === "blocked_address" || r.error === "host_not_allowed") return null;
  }
  return null;
}
