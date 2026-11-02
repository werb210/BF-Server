// BF_SERVER_v873_LENDER_API - lender API addresses must be public HTTPS hosts.
//
// Lender addresses are typed in by an Admin, so they get the same protection as other user-entered URLs
// (src/security/ssrfGuard.ts decides which addresses are private). Checked twice: when the address is saved (shape) and
// on every call, inside the socket's DNS lookup (safeLookup), so a host that later re-points at a private or internal
// address (DNS rebinding) is refused before any connection is made. Redirects are never followed (http.ts).
import dns from "node:dns";
import net from "node:net";
import { isBlockedAddress as guardBlocked } from "../security/ssrfGuard.js";

// Azure's platform endpoint (WireServer / DNS / metadata relay) is a public-looking address reachable inside Azure.
const AZURE_PLATFORM = "168.63.129.16";
const BLOCKED_HOST_SUFFIXES = [".local", ".localhost", ".internal", ".lan", ".home.arpa", ".svc", ".cluster.local"];

export function isBlockedAddress(ip: string): boolean {
  const host = String(ip ?? "").trim().replace(/^\[|\]$/g, "");
  if (host === AZURE_PLATFORM || /^::ffff:168\.63\.129\.16$/i.test(host)) return true;
  return guardBlocked(host);
}

export type UrlCheck = { ok: true; url: URL } | { ok: false; error: string };

/** The shape of an address: https, no credentials, a public-looking host. No DNS lookup. */
export function checkUrlShape(raw: unknown): UrlCheck {
  const s = String(raw ?? "").trim();
  if (!s) return { ok: false, error: "Enter the lender's API address." };
  if (s.length > 2000) return { ok: false, error: "That address is too long." };
  let url: URL;
  try { url = new URL(s); } catch { return { ok: false, error: "That is not a valid address." }; }
  if (url.protocol !== "https:") return { ok: false, error: "API addresses must start with https://." };
  if (url.username || url.password) return { ok: false, error: "Remove the user name and password from the address." };
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase().replace(/\.$/, "");
  if (!host) return { ok: false, error: "The address needs a host name." };
  if (net.isIP(host)) {
    if (isBlockedAddress(host)) return { ok: false, error: "That address is private or internal. Use a public HTTPS address." };
    return { ok: true, url };
  }
  if (host === "localhost" || BLOCKED_HOST_SUFFIXES.some((x) => host.endsWith(x)) || !host.includes(".")) {
    return { ok: false, error: "That host is internal. Use a public HTTPS address." };
  }
  return { ok: true, url };
}

export type Resolver = (host: string) => Promise<Array<{ address: string; family: number }>>;
export const systemResolver: Resolver = (host) => dns.promises.lookup(host, { all: true, verbatim: true });

export class BlockedAddressError extends Error {
  code = "ELENDER_BLOCKED_ADDRESS";
  constructor(host: string, reason: string) {
    super(`${host}: ${reason}; not connecting`);
  }
}

type LookupCallback = (err: NodeJS.ErrnoException | null, address: string | dns.LookupAddress[], family?: number) => void;

/** A net/https `lookup` option that resolves with `resolve` and refuses private targets at connect time. */
export function safeLookup(resolve: Resolver = systemResolver) {
  return (hostname: string, options: dns.LookupOptions | number | undefined, callback: LookupCallback): void => {
    const opts = typeof options === "object" && options !== null ? options : {};
    const literal = net.isIP(hostname) ? [{ address: hostname, family: net.isIP(hostname) }] : null;
    (literal ? Promise.resolve(literal) : resolve(hostname)).then((addrs) => {
      if (!addrs.length) { callback(Object.assign(new Error(`no address for ${hostname}`), { code: "ENOTFOUND" }), "", 0); return; }
      const bad = addrs.find((a) => isBlockedAddress(a.address));
      if (bad) { callback(new BlockedAddressError(hostname, `resolved to a private or internal address (${bad.address})`), "", 0); return; }
      if ((opts as dns.LookupOptions).all) callback(null, addrs.map((a) => ({ address: a.address, family: a.family })));
      else callback(null, addrs[0]!.address, addrs[0]!.family);
    }, (err) => callback(err, "", 0));
  };
}
