// BF_SERVER_v868_QUEBEC_CONSENT - is this visitor in Quebec? Quebec's Law 25 needs consent before Google
// Analytics / Google Ads cookies are set; everywhere else Boreal serves (the rest of Canada and the US)
// Google runs on notice with an opt-out. The client app and the website ask GET /api/privacy/region before
// they load Google.
//
// Signal: the IP address's region from ipinfo.io (IPINFO_TOKEN, already set for the fraud checks). Azure App
// Service and our Front Door set-up add no geo headers, so there is no cheaper server-side signal to read.
//
// Privacy: the address is never logged, never stored and never returned. The short in-memory cache is keyed
// by a salted hash of it (the salt is random per process), so not even the cache holds the address.
import { createHash, randomBytes } from "node:crypto";
import { ipinfoProvider, type IpIntelProvider } from "../fraud/providers/lookups.js";

export type PrivacyRegion = "QC" | "other" | "unknown";

export const REGION_CACHE_TTL_MS = 10 * 60_000;
export const REGION_CACHE_MAX = 5_000;

/** ipinfo gives the region by name ("Quebec"); accept the accented and code forms too. */
export function classifyRegion(country: string | null, region: string | null): PrivacyRegion {
  const c = String(country ?? "").trim().toUpperCase();
  if (!c) return "unknown";
  if (c !== "CA") return "other";
  const r = String(region ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").trim().toLowerCase();
  if (!r) return "unknown";
  return r === "quebec" || r === "qc" || r === "province of quebec" ? "QC" : "other";
}

type Entry = { region: PrivacyRegion; expires: number };

export function createRegionResolver(opts: { provider?: IpIntelProvider; now?: () => number; ttlMs?: number; max?: number } = {}) {
  const provider = opts.provider ?? ipinfoProvider();
  const now = opts.now ?? (() => Date.now());
  const ttl = opts.ttlMs ?? REGION_CACHE_TTL_MS;
  const max = opts.max ?? REGION_CACHE_MAX;
  const salt = randomBytes(16).toString("hex");
  const cache = new Map<string, Entry>();
  const keyFor = (ip: string) => createHash("sha256").update(`${salt}:${ip}`).digest("hex");

  async function resolve(ip: string): Promise<PrivacyRegion> {
    if (!ip || ip === "unknown" || !provider.configured()) return "unknown";
    const key = keyFor(ip);
    const hit = cache.get(key);
    if (hit && hit.expires > now()) return hit.region;
    let region: PrivacyRegion = "unknown";
    try {
      const intel = await provider.lookup(ip);
      region = intel.ok ? classifyRegion(intel.country, intel.region) : "unknown";
    } catch {
      region = "unknown"; // a failed lookup is "unknown"; the client then uses its own fallback
    }
    if (cache.size >= max) {
      // drop expired entries, then the oldest, so the cache stays small
      const t = now();
      for (const [k, v] of cache) if (v.expires <= t) cache.delete(k);
      while (cache.size >= max) cache.delete(cache.keys().next().value as string);
    }
    // A failed lookup is cached briefly too, so a provider outage is not hammered per page view.
    cache.set(key, { region, expires: now() + (region === "unknown" ? Math.min(ttl, 60_000) : ttl) });
    return region;
  }

  return { resolve, size: () => cache.size, clear: () => cache.clear() };
}

let shared: ReturnType<typeof createRegionResolver> | null = null;
export function regionResolver(): ReturnType<typeof createRegionResolver> {
  if (!shared) shared = createRegionResolver();
  return shared;
}
/** Tests swap the provider. */
export function setRegionResolverForTests(r: ReturnType<typeof createRegionResolver> | null): void {
  shared = r;
}
