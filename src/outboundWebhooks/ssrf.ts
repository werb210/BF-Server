// BF_SERVER_v875_WEBHOOKS (ported from KS-server #39) - webhook targets must be public HTTPS hosts.
//
// Checked twice: when an admin saves the URL (the host must resolve, and only to public addresses) and again on every
// delivery, inside the socket's DNS lookup (safeLookup), so a host that later re-points at a private or internal
// address (DNS rebinding) is refused before any connection is made. Redirects are never followed.
import dns from "node:dns";
import net from "node:net";

const blocked = new net.BlockList();
// IPv4: "this" network, private, carrier-grade NAT, loopback, link-local (cloud metadata 169.254.169.254), IETF
// protocol assignments, documentation, benchmarking, multicast, reserved, broadcast.
for (const [addr, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12],
  ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.88.99.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15],
  ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
] as const) blocked.addSubnet(addr, prefix, "ipv4");
// Azure's platform endpoint (WireServer / DNS / metadata relay) is a public-looking address reachable from inside Azure.
blocked.addAddress("168.63.129.16", "ipv4");
// IPv6: unspecified, loopback, unique-local, link-local, site-local, multicast, documentation, discard.
for (const [addr, prefix] of [
  ["::", 128], ["::1", 128], ["fc00::", 7], ["fe80::", 10], ["fec0::", 10], ["ff00::", 8], ["2001:db8::", 32], ["100::", 64],
] as const) blocked.addSubnet(addr, prefix, "ipv6");

function embeddedIpv4(ip: string): string | null {
  const lower = ip.toLowerCase();
  // ::ffff:a.b.c.d (mapped), ::a.b.c.d (compatible), 64:ff9b::a.b.c.d (NAT64)
  const dotted = lower.match(/^(?:::ffff:|::|64:ff9b::)(\d+\.\d+\.\d+\.\d+)$/);
  if (dotted) return dotted[1];
  const hex = lower.match(/^(?:::ffff:|64:ff9b::)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (hex) {
    const a = parseInt(hex[1], 16);
    const b = parseInt(hex[2], 16);
    return `${a >> 8}.${a & 255}.${b >> 8}.${b & 255}`;
  }
  return null;
}

/** Private, loopback, link-local, metadata, multicast or otherwise non-public address? Unparseable = blocked. */
export function isBlockedAddress(ip: string): boolean {
  const kind = net.isIP(ip);
  if (kind === 4) return blocked.check(ip, "ipv4");
  if (kind === 6) {
    const v4 = embeddedIpv4(ip);
    if (v4) return isBlockedAddress(v4);
    return blocked.check(ip, "ipv6");
  }
  return true;
}

const BLOCKED_HOST_SUFFIXES = [".localhost", ".local", ".internal", ".home.arpa", ".lan", ".intranet", ".corp"];

export type UrlCheck = { ok: true; url: URL } | { ok: false; error: string };

/** Shape checks only (no DNS): https, no credentials, a real public host name or a public IP literal. */
export function checkUrlShape(raw: unknown): UrlCheck {
  const s = String(raw ?? "").trim();
  if (!s) return { ok: false, error: "Enter the URL to send events to." };
  if (s.length > 2000) return { ok: false, error: "That URL is too long." };
  let url: URL;
  try { url = new URL(s); } catch { return { ok: false, error: "That is not a valid URL." }; }
  if (url.protocol !== "https:") return { ok: false, error: "Webhook URLs must start with https://." };
  if (url.username || url.password) return { ok: false, error: "Remove the user name and password from the URL." };
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase().replace(/\.$/, "");
  if (!host) return { ok: false, error: "The URL needs a host name." };
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

/** Full check for saving a URL: shape, then every address the host resolves to must be public. */
export async function checkWebhookUrl(raw: unknown, resolve: Resolver = systemResolver): Promise<UrlCheck> {
  const shape = checkUrlShape(raw);
  if (!shape.ok) return shape;
  const host = shape.url.hostname.replace(/^\[|\]$/g, "");
  if (net.isIP(host)) return shape;
  let addrs: Array<{ address: string }>;
  try { addrs = await resolve(host); } catch { return { ok: false, error: "That host name could not be found." }; }
  if (!addrs.length) return { ok: false, error: "That host name could not be found." };
  if (addrs.some((a) => isBlockedAddress(a.address))) return { ok: false, error: "That host points at a private or internal address. Use a public HTTPS address." };
  return shape;
}

export class BlockedAddressError extends Error {
  code = "EWEBHOOK_BLOCKED_ADDRESS";
  constructor(host: string, address: string) {
    super(`${host} resolved to a private or internal address (${address}); not connecting`);
  }
}

type LookupCallback = (err: NodeJS.ErrnoException | null, address: string | dns.LookupAddress[], family?: number) => void;

/**
 * A net/https `lookup` option that resolves with `resolve` and refuses private targets at connect time.
 * Handles both the single-address and the `all: true` callback forms Node may ask for.
 */
export function safeLookup(resolve: Resolver = systemResolver) {
  return (hostname: string, options: dns.LookupOptions | number | undefined, callback: LookupCallback): void => {
    const opts = typeof options === "object" && options !== null ? options : {};
    const literal = net.isIP(hostname) ? [{ address: hostname, family: net.isIP(hostname) }] : null;
    (literal ? Promise.resolve(literal) : resolve(hostname)).then((addrs) => {
      if (!addrs.length) { callback(Object.assign(new Error(`no address for ${hostname}`), { code: "ENOTFOUND" }), "", 0); return; }
      const bad = addrs.find((a) => isBlockedAddress(a.address));
      if (bad) { callback(new BlockedAddressError(hostname, bad.address), "", 0); return; }
      if ((opts as dns.LookupOptions).all) callback(null, addrs.map((a) => ({ address: a.address, family: a.family })));
      else callback(null, addrs[0].address, addrs[0].family);
    }, (err) => callback(err, "", 0));
  };
}
