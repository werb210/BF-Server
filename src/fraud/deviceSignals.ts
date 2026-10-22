// BF_SERVER_v846_FRAUD - device, location and behaviour signals from the client app (checks 9 and 10).
//
// What the client sends (and nothing else): a random device id it generated and keeps in its own storage, the
// platform, a SHA-256 of a few normalised answers, and aggregate behaviour - seconds taken, fields completed, the
// NAMES of sensitive fields that were pasted into, whether autofill was used. Never keystrokes, never field values.
// The server adds the IP address the request came from, looks up its country / region / network when IPINFO_TOKEN
// is set, and stores only keyed hashes of the device id, IP and answers.
import type { Q } from "./types.js";
import { localHash } from "./hash.js";
import type { IpIntelProvider } from "./providers/lookups.js";
import { enqueueFraudRun } from "./store.js";

export type SignalsInput = {
  application_id: string;
  device_id: string | null;
  platform: "web" | "ios" | "android" | null;
  answers_fingerprint: string | null;
  behaviour: {
    completion_seconds: number | null;
    fields_completed: number | null;
    pasted_fields: string[];
    autofill_used: boolean | null;
    steps: number | null;
  };
};

const ID_RE = /^[A-Za-z0-9-]{8,64}$/;

/** Validates and trims the beacon body. Returns null when it is unusable. */
export function parseSignals(body: unknown): SignalsInput | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, any>;
  const appId = String(b.application_id ?? b.applicationToken ?? b.application_token ?? "").trim();
  if (!ID_RE.test(appId)) return null;
  const dev = String(b.device_id ?? "").trim();
  const fp = String(b.answers_fingerprint ?? "").trim().toLowerCase();
  const beh = b.behaviour && typeof b.behaviour === "object" ? b.behaviour : {};
  const num = (v: unknown, max: number) => { const n = Number(v); return Number.isFinite(n) && n >= 0 ? Math.min(n, max) : null; };
  const pasted = Array.isArray(beh.pasted_fields)
    ? [...new Set(beh.pasted_fields.filter((f: unknown) => typeof f === "string").map((f: string) => f.replace(/[^A-Za-z0-9_.-]/g, "").slice(0, 40)).filter(Boolean))].slice(0, 30) as string[]
    : [];
  return {
    application_id: appId,
    device_id: ID_RE.test(dev) ? dev : null,
    platform: b.platform === "ios" || b.platform === "android" || b.platform === "web" ? b.platform : null,
    answers_fingerprint: /^[0-9a-f]{64}$/.test(fp) ? fp : null,
    behaviour: {
      completion_seconds: num(beh.completion_seconds, 86_400 * 30),
      fields_completed: num(beh.fields_completed, 500),
      pasted_fields: pasted,
      autofill_used: typeof beh.autofill_used === "boolean" ? beh.autofill_used : null,
      steps: num(beh.steps, 50),
    },
  };
}

export type RecordResult = "stored" | "unknown_application";

export async function recordSignals(db: Q, s: SignalsInput, ctx: { ip: string | null; ipIntel: IpIntelProvider | null; env?: NodeJS.ProcessEnv }): Promise<RecordResult> {
  const app = await db.query(`SELECT 1 FROM applications WHERE id::text = $1 AND created_at > now() - interval '30 days' LIMIT 1`, [s.application_id]);
  if (!app.rows.length) return "unknown_application";
  const env = ctx.env ?? process.env;
  let intel: { country: string | null; region: string | null; asn: string | null; asnOrg: string | null; flags: Record<string, boolean | null>; provider: string | null } =
    { country: null, region: null, asn: null, asnOrg: null, flags: {}, provider: null };
  if (ctx.ip && ctx.ipIntel?.configured()) {
    const r = await ctx.ipIntel.lookup(ctx.ip);
    if (r.ok) intel = { country: r.country, region: r.region, asn: r.asn, asnOrg: r.asnOrg, flags: { vpn: r.vpn, proxy: r.proxy, hosting: r.hosting, tor: r.tor }, provider: ctx.ipIntel.name };
    else console.warn("[fraud] IP lookup failed", { error: r.error });
  }
  await db.query(
    `INSERT INTO fraud_device_signals (application_id, device_hash, ip_hash, ip_country, ip_region, asn, asn_org, ip_flags, ip_provider, behaviour, answers_hash, platform, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10::jsonb, $11, $12, now())
     ON CONFLICT (application_id) DO UPDATE SET
       device_hash = COALESCE(EXCLUDED.device_hash, fraud_device_signals.device_hash),
       ip_hash = COALESCE(EXCLUDED.ip_hash, fraud_device_signals.ip_hash),
       ip_country = COALESCE(EXCLUDED.ip_country, fraud_device_signals.ip_country),
       ip_region = COALESCE(EXCLUDED.ip_region, fraud_device_signals.ip_region),
       asn = COALESCE(EXCLUDED.asn, fraud_device_signals.asn), asn_org = COALESCE(EXCLUDED.asn_org, fraud_device_signals.asn_org),
       ip_flags = CASE WHEN EXCLUDED.ip_provider IS NULL THEN fraud_device_signals.ip_flags ELSE EXCLUDED.ip_flags END,
       ip_provider = COALESCE(EXCLUDED.ip_provider, fraud_device_signals.ip_provider),
       behaviour = EXCLUDED.behaviour, answers_hash = COALESCE(EXCLUDED.answers_hash, fraud_device_signals.answers_hash),
       platform = COALESCE(EXCLUDED.platform, fraud_device_signals.platform), updated_at = now()`,
    [
      s.application_id,
      localHash("device", s.device_id, env),
      localHash("ip", ctx.ip, env),
      intel.country, intel.region, intel.asn, intel.asnOrg, JSON.stringify(intel.flags), intel.provider,
      JSON.stringify(s.behaviour),
      localHash("answers", s.answers_fingerprint, env),
      s.platform,
    ],
  );
  await enqueueFraudRun(db, s.application_id, "device_signals");
  return "stored";
}
