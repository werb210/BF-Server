// BF_SERVER_v846_FRAUD - check 13: the shared fraud watchlist across Keystone brokerages. Boreal joins as a member
// (opt-in by an Admin in Settings -> Fraud protection).
//
// When a file is confirmed as fraud (parked in the Fraud stage), this copy sends KEYED HASHES of its identifiers -
// phone numbers, email, business number, addresses, bank account, the person's name with date of birth - to
// Keystone operations. Each hash is HMAC-SHA256(KS_WATCHLIST_PEPPER, kind:normalised value). Every Keystone copy has
// the same pepper, so the same phone number hashes the same everywhere; Keystone operations never has the pepper and
// stores only hashes, so no personal data leaves the brokerage. New applications are checked against the list; a
// match says how many other brokerages reported it, never who or what the file was.
//   POST {KS_OPS_URL}/api/licensees/{id}/watchlist/opt-in   { opt_in }
//   POST {KS_OPS_URL}/api/licensees/{id}/watchlist/report   { application_ref, entries: [{ kind, hash }] }
//   POST {KS_OPS_URL}/api/licensees/{id}/watchlist/withdraw { application_ref }
//   POST {KS_OPS_URL}/api/licensees/{id}/watchlist/check    { entries } -> { matches: [{ kind, hash, brokerages, reports }] }
import { localHash, normAddress, normDigits, normEmail, normName, normPhone, watchlistHash, watchlistPepper } from "./hash.js";
import type { AppProfile } from "./profile.js";
import { opsConfig, postToOps, type OpsFetch } from "./opsLink.js";
import { notApplicable, notConfigured, result, type CheckResult, type Reason } from "./types.js";
import { normalizeDob } from "./checks/identity.js";

export type WatchKind = "phone" | "email" | "business_number" | "address" | "bank_account" | "person";
export type WatchEntry = { kind: WatchKind; hash: string };

const KIND_TEXT: Record<WatchKind, string> = {
  phone: "phone number", email: "email address", business_number: "business number", address: "address",
  bank_account: "bank account", person: "name and date of birth",
};

export function watchlistEntries(p: AppProfile, extra: { bankAccounts?: string[] } = {}, env: NodeJS.ProcessEnv = process.env): WatchEntry[] {
  const raw: Array<[WatchKind, string | null]> = [
    ["phone", normPhone(p.applicant.phone)], ["phone", normPhone(p.businessPhone)],
    ["email", normEmail(p.applicant.email)],
    ["business_number", normDigits(p.businessNumber, 9)?.slice(0, 9) ?? null],
    ["address", normAddress(p.businessAddress)], ["address", normAddress(p.applicant.address)],
    ...(extra.bankAccounts ?? []).map((a) => ["bank_account", normDigits(a, 5)] as [WatchKind, string | null]),
    ...[p.applicant, ...p.owners].map((o) => {
      const n = normName(o.name), d = normalizeDob(o.dob);
      return ["person", n && d ? `${n}|${d}` : null] as [WatchKind, string | null];
    }),
  ];
  const seen = new Set<string>();
  const out: WatchEntry[] = [];
  for (const [kind, v] of raw) {
    const hash = watchlistHash(kind, v, env);
    if (hash && !seen.has(hash)) { seen.add(hash); out.push({ kind, hash }); }
  }
  return out;
}

/** An opaque reference for the application (so a report can be withdrawn) - never the application id itself. */
export function applicationRef(applicationId: string, env: NodeJS.ProcessEnv = process.env): string {
  return localHash("watchlist-ref", applicationId, env)!;
}

export type WatchlistReady = { ok: true } | { ok: false; why: "pepper" | "ops" };

export function watchlistReady(env: NodeJS.ProcessEnv = process.env): WatchlistReady {
  if (!watchlistPepper(env)) return { ok: false, why: "pepper" };
  if (!opsConfig(env)) return { ok: false, why: "ops" };
  return { ok: true };
}

export type WatchMatch = { kind: WatchKind; hash: string; brokerages: number; reports: number };

export async function checkWatchlist(entries: WatchEntry[], opts: { env?: NodeJS.ProcessEnv; fetchImpl?: OpsFetch } = {}): Promise<{ ok: true; matches: WatchMatch[] } | { ok: false; error: string }> {
  if (!entries.length) return { ok: true, matches: [] };
  const r = await postToOps("watchlist/check", { entries }, opts);
  if (!r.ok) return { ok: false, error: r.error };
  const matches = Array.isArray(r.body?.matches) ? r.body.matches : [];
  return {
    ok: true,
    matches: matches
      .filter((m: any) => m && typeof m.hash === "string" && entries.some((e) => e.hash === m.hash))
      .map((m: any) => ({ kind: (entries.find((e) => e.hash === m.hash)!.kind), hash: m.hash, brokerages: Number(m.brokerages ?? 1) || 1, reports: Number(m.reports ?? 1) || 1 })),
  };
}

export function evaluateWatchlist(i: { optIn: boolean; ready: WatchlistReady; check: { ok: true; matches: WatchMatch[] } | { ok: false; error: string } | null; entries: number }): CheckResult {
  if (!i.optIn) return notApplicable("Watchlist sharing is off. An Admin can turn it on in Settings -> Fraud protection.");
  if (!i.ready.ok) return notConfigured(i.ready.why === "pepper" ? "The shared watchlist key (KS_WATCHLIST_PEPPER) is not set on this server." : "The link to the Keystone watchlist (KS_OPS_URL, KS_LICENSEE_ID, KS_OPS_KEY) is not set up.", "ks_ops");
  if (!i.entries) return notApplicable("The application has no phone, email, business number, address or bank details to check yet.");
  if (!i.check || !i.check.ok) return { status: "error", reasons: [{ code: "watchlist_error", severity: "info", text: "The shared watchlist could not be reached; the worker will try again." }], provider: "ks_ops" };
  if (!i.check.matches.length) return result([{ code: "watchlist_clear", severity: "info", text: `None of the ${i.entries} identifiers match confirmed fraud reported by other brokerages.` }], { checked: i.entries }, "ks_ops");
  const reasons: Reason[] = i.check.matches.map((m) => ({
    code: `watchlist_${m.kind}`, severity: "red",
    text: `The ${KIND_TEXT[m.kind]} matches confirmed fraud reported by ${m.brokerages} other brokerage${m.brokerages === 1 ? "" : "s"}.`,
  }));
  return result(reasons, { checked: i.entries, matches: i.check.matches.length }, "ks_ops");
}
