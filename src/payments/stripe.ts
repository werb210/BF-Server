// BF_SERVER_v872_PAYMENTS - Stripe over plain fetch (no SDK), on Boreal's own Stripe account (ported from KS-server #47;
// Keystone's Stripe Connect platform layer is not used: Boreal is the merchant and charges are made with its own key).
// Server settings:
//   STRIPE_SECRET_KEY      Boreal's secret key (sk_live_... / sk_test_...), or a restricted key with Checkout Sessions
//                          write and Account read
//   STRIPE_WEBHOOK_SECRET  signing secret (whsec_...) of the webhook endpoint <server>/api/payments/stripe/webhook
//                          (events: checkout.session.completed, checkout.session.async_payment_succeeded,
//                          checkout.session.async_payment_failed, checkout.session.expired)
import { createHmac, timingSafeEqual } from "node:crypto";

export const STRIPE_API = "https://api.stripe.com/v1";
export const STRIPE_VERSION = "2024-06-20";
export const WEBHOOK_TOLERANCE_SECONDS = 300;

const env = (name: string, e: NodeJS.ProcessEnv) => String(e[name] ?? "").trim();

export type StripeConfig = { secretKey: string; webhookSecret: string; livemode: boolean };

export const STRIPE_SETTINGS = ["STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET"] as const;

/** Why payments cannot be used on this server, or null when Stripe is set up. Names the settings, never their values. */
export function stripeConfigProblem(e: NodeJS.ProcessEnv = process.env): string | null {
  const missing = STRIPE_SETTINGS.filter((n) => !env(n, e));
  return missing.length ? `Online payments are not set up on this server yet (${missing.join(", ")}).` : null;
}

export function stripeConfig(e: NodeJS.ProcessEnv = process.env): StripeConfig | null {
  if (stripeConfigProblem(e)) return null;
  const secretKey = env("STRIPE_SECRET_KEY", e);
  return { secretKey, webhookSecret: env("STRIPE_WEBHOOK_SECRET", e), livemode: /^(sk|rk)_live_/.test(secretKey) };
}

export class StripeError extends Error {
  constructor(public status: number, public code: string | null, message: string, public type: string | null = null) {
    super(message);
    this.name = "StripeError";
  }
}

/** Stripe's form encoding: nested objects as a[b][c]=v, arrays as a[0]=v. Null/undefined are left out. */
export function formEncode(params: Record<string, unknown>): string {
  const out: string[] = [];
  const add = (key: string, v: unknown) => {
    if (v === null || v === undefined) return;
    if (Array.isArray(v)) { v.forEach((x, i) => add(`${key}[${i}]`, x)); return; }
    if (typeof v === "object") { for (const [k, x] of Object.entries(v as Record<string, unknown>)) add(`${key}[${k}]`, x); return; }
    out.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(v))}`);
  };
  for (const [k, v] of Object.entries(params)) add(k, v);
  return out.join("&");
}

export type Fetch = (url: string, init?: RequestInit) => Promise<Response>;
let fetchImpl: Fetch = (url, init) => fetch(url, init);
/** Test seam. */
export function setStripeFetchForTests(f: Fetch | null): void {
  fetchImpl = f ?? ((url, init) => fetch(url, init));
}

async function parse(resp: Response): Promise<any> {
  const text = await resp.text();
  let json: any = {};
  try { json = text ? JSON.parse(text) : {}; } catch { json = { error: { message: text.slice(0, 300) } }; }
  if (!resp.ok) {
    const e = json?.error ?? {};
    const code = typeof e === "string" ? e : (e.code ?? null);
    const message = typeof e === "string" ? String(json.error_description ?? e) : String(e.message ?? `stripe_${resp.status}`);
    throw new StripeError(resp.status, code, message, typeof e === "object" ? (e.type ?? null) : null);
  }
  return json;
}

/** One Stripe API call with Boreal's key. */
export async function stripeRequest<T = any>(cfg: StripeConfig, method: "GET" | "POST" | "DELETE", path: string,
  params: Record<string, unknown> = {}, opts: { idempotencyKey?: string } = {}): Promise<T> {
  const headers: Record<string, string> = { Authorization: `Bearer ${cfg.secretKey}`, "Stripe-Version": STRIPE_VERSION };
  if (opts.idempotencyKey) headers["Idempotency-Key"] = opts.idempotencyKey;
  const body = formEncode(params);
  let url = `${STRIPE_API}${path}`;
  const init: RequestInit = { method, headers };
  if (method === "GET") { if (body) url += `?${body}`; }
  else { headers["Content-Type"] = "application/x-www-form-urlencoded"; init.body = body; }
  return parse(await fetchImpl(url, init)) as Promise<T>;
}

export type AccountSummary = { id: string | null; business_name: string | null; country: string | null; default_currency: string | null;
  charges_enabled: boolean | null; acss_debit_enabled: boolean | null; livemode: boolean };

let accountCache: { at: number; key: string; value: AccountSummary } | null = null;
const ACCOUNT_TTL_MS = 5 * 60_000;

/** Boreal's Stripe account: its name, and whether cards and Canadian bank debits are switched on (cached 5 minutes). */
export async function accountSummary(cfg: StripeConfig, now = Date.now()): Promise<AccountSummary> {
  if (accountCache && accountCache.key === cfg.secretKey && now - accountCache.at < ACCOUNT_TTL_MS) return accountCache.value;
  const a = await stripeRequest<any>(cfg, "GET", "/account");
  const caps = a?.capabilities ?? {};
  const value: AccountSummary = {
    id: a?.id ? String(a.id) : null,
    business_name: a?.business_profile?.name ?? a?.settings?.dashboard?.display_name ?? null,
    country: a?.country ?? null, default_currency: a?.default_currency ?? null,
    charges_enabled: typeof a?.charges_enabled === "boolean" ? a.charges_enabled : null,
    acss_debit_enabled: caps.acss_debit_payments ? caps.acss_debit_payments === "active" : null,
    livemode: cfg.livemode,
  };
  accountCache = { at: now, key: cfg.secretKey, value };
  return value;
}

/** Test seam. */
export function clearStripeAccountCache(): void {
  accountCache = null;
}

/** Stripe-Signature check: t=<unix>,v1=<hex hmac of "t.payload">. Rejects stale timestamps. */
export function verifyStripeSignature(rawBody: Buffer | string, header: string | undefined, secret: string,
  nowSeconds = Math.floor(Date.now() / 1000), tolerance = WEBHOOK_TOLERANCE_SECONDS): boolean {
  if (!header || !secret) return false;
  const parts = header.split(",").map((p) => p.trim().split("="));
  const t = Number(parts.find(([k]) => k === "t")?.[1]);
  const sigs = parts.filter(([k]) => k === "v1").map(([, v]) => String(v ?? ""));
  if (!Number.isFinite(t) || !sigs.length) return false;
  if (Math.abs(nowSeconds - t) > tolerance) return false;
  const expected = createHmac("sha256", secret).update(`${t}.${typeof rawBody === "string" ? rawBody : rawBody.toString("utf8")}`).digest("hex");
  const exp = Buffer.from(expected, "hex");
  return sigs.some((s) => {
    const got = /^[0-9a-f]+$/i.test(s) ? Buffer.from(s, "hex") : Buffer.alloc(0);
    return got.length === exp.length && timingSafeEqual(got, exp);
  });
}

/** Builds a Stripe-Signature header (tests). */
export function signStripePayload(payload: string, secret: string, t = Math.floor(Date.now() / 1000)): string {
  return `t=${t},v1=${createHmac("sha256", secret).update(`${t}.${payload}`).digest("hex")}`;
}
