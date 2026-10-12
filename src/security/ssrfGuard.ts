// BF_SERVER_v789_SSRF_GUARD
// Outbound fetches to URLs a user typed (Maya "train from URL", workflow webhook
// steps) must never reach an internal address. Every hop's host is resolved
// (dns.promises.lookup, all: true) and refused if ANY address is private,
// loopback, link-local, CGNAT, metadata, "this network", multicast/reserved, or
// an IPv6 equivalent (::, ::1, fc00::/7, fe80::/10, IPv4-mapped/compatible/NAT64
// forms of a blocked IPv4). Redirects are followed by hand (redirect: "manual",
// at most 3) and each hop is checked again.
//
// Residual risk: fetch resolves the name again when it connects, so a DNS
// answer that changes between the check and the connect (rebinding) is not
// covered. Node's bundled fetch exposes no dispatcher to pin the address.
import { promises as dnsPromises } from "node:dns";
import { isIP } from "node:net";

export class SsrfBlockedError extends Error {
  readonly code: string;
  constructor(code: string, message?: string) {
    super(message ?? code);
    this.name = "SsrfBlockedError";
    this.code = code;
  }
}

export type LookupAddress = { address: string; family?: number };
export type LookupFn = (host: string) => Promise<LookupAddress[]>;

export const defaultLookup: LookupFn = async (host) => {
  // Read dnsPromises.lookup at call time so tests can stub it.
  const out = await dnsPromises.lookup(host, { all: true, verbatim: true });
  return Array.isArray(out) ? out : [out as LookupAddress];
};

function ipv4Blocked(ip: string): boolean {
  const p = ip.split(".").map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a, b, c] = p as [number, number, number, number];
  if (a === 0) return true; // 0.0.0.0/8 "this network"
  if (a === 10) return true; // 10/8
  if (a === 127) return true; // loopback
  if (a === 169 && b === 254) return true; // link-local, incl. 169.254.169.254 metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16/12
  if (a === 192 && b === 168) return true; // 192.168/16
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64/10
  if (a === 192 && b === 0 && c === 0) return true; // 192.0.0/24 IETF protocol assignments
  if (a === 198 && (b === 18 || b === 19)) return true; // 198.18/15 benchmarking
  if (a >= 224) return true; // multicast, reserved, broadcast
  return false;
}

// Expand an IPv6 literal to 8 16-bit groups (an embedded dotted IPv4 tail is
// folded into the last two groups). Returns null when it does not parse.
function ipv6Groups(ip: string): number[] | null {
  let s = ip.toLowerCase();
  const zone = s.indexOf("%");
  if (zone >= 0) s = s.slice(0, zone);
  let tail: number[] = [];
  const lastColon = s.lastIndexOf(":");
  if (s.slice(lastColon + 1).includes(".")) {
    const v4 = s.slice(lastColon + 1);
    if (isIP(v4) !== 4) return null;
    const q = v4.split(".").map(Number) as [number, number, number, number];
    tail = [(q[0] << 8) | q[1], (q[2] << 8) | q[3]];
    s = s.slice(0, lastColon + 1) + "0:0";
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const parse = (part: string) => (part ? part.split(":") : []).map((h) => (/^[0-9a-f]{1,4}$/.test(h) ? parseInt(h, 16) : NaN));
  const head = parse(halves[0] ?? "");
  const rest = halves.length === 2 ? parse(halves[1] ?? "") : [];
  const fill = halves.length === 2 ? 8 - head.length - rest.length : 0;
  if (fill < 0) return null;
  const groups = [...head, ...new Array(fill).fill(0), ...rest];
  if (groups.length !== 8 || groups.some((g) => Number.isNaN(g))) return null;
  if (tail.length) { groups[6] = tail[0]!; groups[7] = tail[1]!; }
  return groups;
}

function v4FromGroups(g6: number, g7: number): string {
  return [g6 >> 8, g6 & 0xff, g7 >> 8, g7 & 0xff].join(".");
}

function ipv6Blocked(ip: string): boolean {
  const g = ipv6Groups(ip);
  if (!g) return true;
  const zeros = (from: number, to: number) => g.slice(from, to).every((x) => x === 0);
  if (zeros(0, 8)) return true; // ::
  if (zeros(0, 7) && g[7] === 1) return true; // ::1
  if ((g[0]! & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
  if ((g[0]! & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((g[0]! & 0xffc0) === 0xfec0) return true; // fec0::/10 deprecated site-local
  if ((g[0]! & 0xff00) === 0xff00) return true; // multicast
  if (zeros(0, 5) && g[5] === 0xffff) return ipv4Blocked(v4FromGroups(g[6]!, g[7]!)); // ::ffff:a.b.c.d mapped
  if (zeros(0, 6)) return ipv4Blocked(v4FromGroups(g[6]!, g[7]!)); // ::a.b.c.d compatible
  if (g[0] === 0x64 && g[1] === 0xff9b && zeros(2, 6)) return ipv4Blocked(v4FromGroups(g[6]!, g[7]!)); // NAT64 64:ff9b::/96
  if (g[0] === 0x2002) return ipv4Blocked(v4FromGroups(g[1]!, g[2]!)); // 6to4 embeds an IPv4
  return false;
}

/** True when the address must not be fetched. Anything that is not an IP literal is blocked. */
export function isBlockedAddress(ip: string): boolean {
  const host = String(ip ?? "").trim().replace(/^\[|\]$/g, "");
  const v = isIP(host.split("%")[0] ?? "");
  if (v === 4) return ipv4Blocked(host);
  if (v === 6) return ipv6Blocked(host);
  return true;
}

export type SsrfOptions = {
  httpsOnly?: boolean;
  maxRedirects?: number;
  lookup?: LookupFn;
};

/** Throws SsrfBlockedError unless the URL's scheme is allowed and every address its host resolves to is public. */
export async function assertPublicUrl(url: URL, opts: SsrfOptions = {}): Promise<void> {
  const allowed = opts.httpsOnly ? ["https:"] : ["https:", "http:"];
  if (!allowed.includes(url.protocol)) throw new SsrfBlockedError("scheme_not_allowed", opts.httpsOnly ? "URL must be https" : "URL must be http(s)");
  if (url.username || url.password) throw new SsrfBlockedError("credentials_not_allowed");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (!host) throw new SsrfBlockedError("host_missing");
  let addrs: LookupAddress[];
  if (isIP(host)) addrs = [{ address: host }];
  else {
    try {
      addrs = await (opts.lookup ?? defaultLookup)(host);
    } catch (err) {
      throw new SsrfBlockedError("dns_failed", `could not resolve ${host}: ${(err as Error)?.message ?? String(err)}`);
    }
  }
  if (!addrs.length) throw new SsrfBlockedError("dns_failed", `could not resolve ${host}`);
  if (addrs.some((a) => isBlockedAddress(a.address))) throw new SsrfBlockedError("address_not_public", `${host} resolves to a non-public address`);
}

export type GuardedResult<R> = { response: R; url: URL };

/**
 * fetch with the SSRF checks above on the first URL and on every redirect hop.
 * 303 (and 301/302 after a non-GET) continue as GET without a body, as browsers do.
 */
export async function ssrfSafeFetch<R extends { ok: boolean; status: number; headers?: any } = Response>(
  rawUrl: string | URL,
  init: Record<string, any> = {},
  opts: SsrfOptions & { fetchImpl?: (url: string, init: any) => Promise<R> } = {},
): Promise<GuardedResult<R>> {
  let current: URL;
  try { current = new URL(String(rawUrl)); } catch { throw new SsrfBlockedError("invalid_url", "URL is invalid"); }
  const maxRedirects = opts.maxRedirects ?? 3;
  const doFetch = opts.fetchImpl ?? ((u: string, i: any) => fetch(u, i) as unknown as Promise<R>);
  let reqInit: Record<string, any> = { ...init };
  for (let hop = 0; ; hop++) {
    await assertPublicUrl(current, opts);
    const response = await doFetch(current.toString(), { ...reqInit, redirect: "manual" });
    if (response.status < 300 || response.status >= 400) return { response, url: current };
    const location = typeof response.headers?.get === "function" ? response.headers.get("location") : null;
    if (!location) return { response, url: current };
    if (hop >= maxRedirects) throw new SsrfBlockedError("too_many_redirects", `more than ${maxRedirects} redirects`);
    let next: URL;
    try { next = new URL(location, current); } catch { throw new SsrfBlockedError("invalid_redirect", "redirect location is invalid"); }
    const method = String(reqInit.method ?? "GET").toUpperCase();
    if (response.status === 303 || ((response.status === 301 || response.status === 302) && method !== "GET" && method !== "HEAD")) {
      reqInit = { ...reqInit, method: "GET" };
      delete reqInit.body;
    }
    current = next;
  }
}
