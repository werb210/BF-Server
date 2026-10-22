// BF_SERVER_v846_FRAUD - keyed hashes and the normalisers behind them.
//
// Two keys:
//  - the LOCAL key (derived from JWT_SECRET, never stored) hashes device ids, IP addresses and answer fingerprints
//    kept in this copy's database. Equality is all the checks need, so the raw values are never stored.
//  - KS_WATCHLIST_PEPPER (the same value on every Keystone copy, issued by Keystone operations) hashes identifiers
//    shared with the network watchlist, so two brokerages produce the same hash for the same phone number while
//    Keystone operations (which never has the pepper) cannot reverse them.
import { createHash, createHmac } from "node:crypto";

export function localKey(env: NodeJS.ProcessEnv = process.env): string {
  const base = String(env.JWT_SECRET ?? "").trim() || "ks-fraud-local-fallback";
  return createHash("sha256").update(`ks-fraud-local:${base}`).digest("hex");
}

/** HMAC-SHA256(local key, kind:value) - for values kept in this copy only. Empty input -> null. */
export function localHash(kind: string, value: string | null | undefined, env: NodeJS.ProcessEnv = process.env): string | null {
  const v = String(value ?? "").trim();
  if (!v) return null;
  return createHmac("sha256", localKey(env)).update(`${kind}:${v}`).digest("hex");
}

export function watchlistPepper(env: NodeJS.ProcessEnv = process.env): string | null {
  const p = String(env.KS_WATCHLIST_PEPPER ?? "").trim();
  return p.length >= 16 ? p : null;
}

/** HMAC-SHA256(KS_WATCHLIST_PEPPER, kind:normalised value), or null when the pepper is not set / value empty. */
export function watchlistHash(kind: string, normalised: string | null, env: NodeJS.ProcessEnv = process.env): string | null {
  const pepper = watchlistPepper(env);
  if (!pepper || !normalised) return null;
  return createHmac("sha256", pepper).update(`${kind}:${normalised}`).digest("hex");
}

export function normEmail(v: unknown): string | null {
  const s = String(v ?? "").trim().toLowerCase();
  const m = s.match(/^([^\s@]+)@([^\s@]+\.[^\s@]+)$/);
  if (!m) return null;
  const local = m[1]!.replace(/\+.*$/, "");
  const domain = m[2]!;
  // Gmail ignores dots in the local part; treat a.b@gmail.com and ab@gmail.com as one address.
  const l = domain === "gmail.com" || domain === "googlemail.com" ? local.replace(/\./g, "") : local;
  return `${l}@${domain === "googlemail.com" ? "gmail.com" : domain}`;
}

export function emailDomain(v: unknown): string | null {
  const e = normEmail(v);
  return e ? e.split("@")[1]! : null;
}

/** North American numbers as 10 digits; others as all digits (8+). */
export function normPhone(v: unknown): string | null {
  const d = String(v ?? "").replace(/\D/g, "");
  if (d.length === 11 && d.startsWith("1")) return d.slice(1);
  if (d.length >= 8 && d.length <= 15) return d;
  return null;
}

export function toE164(v: unknown): string | null {
  const p = normPhone(v);
  if (!p) return null;
  return p.length === 10 ? `+1${p}` : `+${p}`;
}

export function normName(v: unknown): string | null {
  const s = String(v ?? "")
    .normalize("NFKD").replace(/[̀-ͯ]/g, "")
    .toLowerCase().replace(/[^a-z\s'-]/g, " ").replace(/\s+/g, " ").trim();
  return s.length >= 2 ? s : null;
}

const ADDRESS_ABBR: Array<[RegExp, string]> = [
  [/\bstreet\b/g, "st"], [/\bavenue\b/g, "ave"], [/\broad\b/g, "rd"], [/\bdrive\b/g, "dr"], [/\bboulevard\b/g, "blvd"],
  [/\bcourt\b/g, "crt"], [/\bct\b/g, "crt"], [/\bcrescent\b/g, "cres"], [/\bplace\b/g, "pl"], [/\bsuite\b/g, "ste"],
  [/\bunit\b/g, "ste"], [/\bnorth\b/g, "n"], [/\bsouth\b/g, "s"], [/\beast\b/g, "e"], [/\bwest\b/g, "w"],
  [/\bnorthwest\b/g, "nw"], [/\bnortheast\b/g, "ne"], [/\bsouthwest\b/g, "sw"], [/\bsoutheast\b/g, "se"],
];

export function normAddress(v: unknown): string | null {
  let s = String(v ?? "").toLowerCase().replace(/[.,#]/g, " ").replace(/\s+/g, " ").trim();
  if (s.length < 6) return null;
  for (const [re, rep] of ADDRESS_ABBR) s = s.replace(re, rep);
  return s.replace(/\s+/g, " ").trim();
}

/** Business numbers / account numbers: digits only, 5+. */
export function normDigits(v: unknown, min = 5): string | null {
  const d = String(v ?? "").replace(/\D/g, "");
  return d.length >= min ? d : null;
}

export function normDomain(v: unknown): string | null {
  let s = String(v ?? "").trim().toLowerCase();
  if (!s) return null;
  s = s.replace(/^[a-z]+:\/\//, "").replace(/^www\./, "").split(/[/?#:]/)[0] ?? "";
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(s) ? s : null;
}
