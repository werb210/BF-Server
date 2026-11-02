// BF_SERVER_v875_SSO (ported from KS-server #35, Microsoft only, plan gate removed) - staff sign-in with Microsoft
// (Entra ID): OpenID Connect authorization code flow with PKCE (S256), state and nonce, on Boreal's existing Entra app
// (client c8890d6f-eb8f-4101-8336-5e8fca3303e0, tenant b585ab8e-bd39-449d-9210-479a9c989bb2 - the same registration
// the portal's Microsoft 365 connection uses). The id_token is checked here, never trusted as sent:
//   * signature: RS256 against Microsoft's published JWKS (cached an hour, refetched once for an unknown kid)
//   * issuer: https://login.microsoftonline.com/{tid}/v2.0, and tid must be Boreal's tenant (always pinned, so the
//     email / sign-in name is one Boreal's own directory issued)
//   * audience: the client id; expiry / not-before (60 s clock skew); nonce: the one this sign-in stored
// The client secret is MSAL_CLIENT_SECRET (already set for the Microsoft 365 connection). Unset = not offered.
import { createHash, createPublicKey, randomBytes, type KeyObject } from "node:crypto";
import jwt from "jsonwebtoken";

export const SSO_PROVIDERS = ["microsoft"] as const;
export type SsoProvider = (typeof SSO_PROVIDERS)[number];

export function isSsoProvider(v: unknown): v is SsoProvider {
  return typeof v === "string" && (SSO_PROVIDERS as readonly string[]).includes(v);
}

export const BOREAL_ENTRA_CLIENT_ID = "c8890d6f-eb8f-4101-8336-5e8fca3303e0";
export const BOREAL_ENTRA_TENANT_ID = "b585ab8e-bd39-449d-9210-479a9c989bb2";

export const STATE_TTL_MS = 10 * 60 * 1000;
export const HANDOFF_TTL_MS = 60 * 1000;
const CLOCK_SKEW_S = 60;

export const MS_LOGIN_BASE = "https://login.microsoftonline.com";
export const MS_JWKS_URL = `${MS_LOGIN_BASE}/common/discovery/v2.0/keys`;

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isTenantId(v: string): boolean {
  return GUID.test(v);
}

const env = (name: string, e: NodeJS.ProcessEnv): string => String(e[name] ?? "").trim();

export function serverBaseUrl(e: NodeJS.ProcessEnv = process.env): string {
  return (env("PUBLIC_BASE_URL", e) || "https://server.boreal.financial").replace(/\/+$/, "");
}

export type ProviderConfig = {
  provider: SsoProvider;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  /** Boreal's Entra tenant: the authority, and the only tenant whose tokens are accepted. */
  tenantId: string;
};

/** The server-side configuration, or null when the client secret is not set (Microsoft sign-in not offered). */
export function providerConfig(_provider: SsoProvider = "microsoft", e: NodeJS.ProcessEnv = process.env): ProviderConfig | null {
  const clientSecret = env("MSAL_CLIENT_SECRET", e);
  if (!clientSecret) return null;
  const clientId = env("MSAL_CLIENT_ID", e) || BOREAL_ENTRA_CLIENT_ID;
  const pinned = env("SSO_MICROSOFT_TENANT", e) || env("MSAL_TENANT_ID", e);
  const tenantId = (isTenantId(pinned) ? pinned : BOREAL_ENTRA_TENANT_ID).toLowerCase();
  return {
    provider: "microsoft", clientId, clientSecret, tenantId,
    redirectUri: env("SSO_MICROSOFT_REDIRECT_URI", e) || serverBaseUrl(e) + "/api/auth/sso/microsoft/callback",
  };
}

/** Where the browser lands after a sign-in (the portal's sign-in page reads the hand-off code from the hash). */
export function ssoReturnUrl(e: NodeJS.ProcessEnv = process.env): string {
  const explicit = env("SSO_RETURN_URL", e);
  if (explicit) return explicit;
  return (env("PORTAL_URL", e) || "https://staff.boreal.financial").replace(/\/+$/, "") + "/login";
}

export function sha256Hex(v: string): string {
  return createHash("sha256").update(v, "utf8").digest("hex");
}
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}
export function codeChallenge(verifier: string): string {
  return createHash("sha256").update(verifier, "ascii").digest("base64url");
}

export type AuthorizeInput = { state: string; nonce: string; verifier: string; loginHint?: string };

export function buildAuthorizeUrl(cfg: ProviderConfig, input: AuthorizeInput): string {
  const params = new URLSearchParams({
    client_id: cfg.clientId,
    redirect_uri: cfg.redirectUri,
    response_type: "code",
    response_mode: "query",
    scope: "openid email profile",
    state: input.state,
    nonce: input.nonce,
    code_challenge: codeChallenge(input.verifier),
    code_challenge_method: "S256",
    prompt: "select_account",
  });
  if (input.loginHint) params.set("login_hint", input.loginHint);
  return `${MS_LOGIN_BASE}/${encodeURIComponent(cfg.tenantId)}/oauth2/v2.0/authorize?${params.toString()}`;
}

export function tokenUrlFor(cfg: ProviderConfig): string {
  return `${MS_LOGIN_BASE}/${encodeURIComponent(cfg.tenantId)}/oauth2/v2.0/token`;
}

export type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

/** Redeems the authorization code (with the PKCE verifier and the client secret) for the id_token. */
export async function exchangeCodeForIdToken(cfg: ProviderConfig, code: string, verifier: string, fetcher: Fetcher = fetch): Promise<string> {
  const body = new URLSearchParams({
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
    code,
    code_verifier: verifier,
    redirect_uri: cfg.redirectUri,
    grant_type: "authorization_code",
    scope: "openid email profile",
  });
  const r = await fetcher(tokenUrlFor(cfg), {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  let json: { id_token?: unknown; error?: unknown } = {};
  try {
    json = (await r.json()) as typeof json;
  } catch (err) {
    console.warn("[sso] token endpoint answered without JSON", { status: r.status, message: (err as Error)?.message });
  }
  if (!r.ok || typeof json.id_token !== "string" || !json.id_token) {
    throw new SsoError("exchange_failed", `token endpoint answered ${r.status}${json.error ? ` (${String(json.error).slice(0, 60)})` : ""}`);
  }
  return json.id_token;
}

export type SsoRefusal =
  | "exchange_failed" | "bad_token" | "bad_signature" | "wrong_issuer" | "wrong_audience" | "expired" | "bad_nonce"
  | "email_not_verified" | "wrong_tenant";

export class SsoError extends Error {
  constructor(public reason: SsoRefusal, message?: string) {
    super(message ?? reason);
    this.name = "SsoError";
  }
}

// ---- JWKS -------------------------------------------------------------------------------------------------------

type Jwk = { kid?: string; kty?: string; alg?: string; use?: string; n?: string; e?: string };
type KeySet = { at: number; keys: Map<string, KeyObject> };
const JWKS_TTL_MS = 60 * 60 * 1000;
const JWKS_MIN_REFRESH_MS = 60 * 1000;
const jwksCache = new Map<string, KeySet>();

export function clearJwksCache(): void {
  jwksCache.clear();
}

async function loadJwks(url: string, fetcher: Fetcher): Promise<KeySet> {
  const r = await fetcher(url);
  if (!r.ok) throw new SsoError("bad_signature", `JWKS ${url} answered ${r.status}`);
  const json = (await r.json()) as { keys?: Jwk[] };
  const keys = new Map<string, KeyObject>();
  for (const k of Array.isArray(json.keys) ? json.keys : []) {
    if (!k.kid || k.kty !== "RSA" || !k.n || !k.e) continue;
    try {
      keys.set(k.kid, createPublicKey({ key: { kty: "RSA", n: k.n, e: k.e }, format: "jwk" }));
    } catch (err) {
      console.warn("[sso] skipped an unreadable JWKS key", { kid: k.kid, message: (err as Error)?.message });
    }
  }
  const set = { at: Date.now(), keys };
  jwksCache.set(url, set);
  return set;
}

/** The signing key for this kid, from the cached set; an unknown kid refetches the set (at most once a minute). */
export async function jwksKey(url: string, kid: string, fetcher: Fetcher = fetch): Promise<KeyObject | null> {
  let set = jwksCache.get(url);
  if (!set || Date.now() - set.at > JWKS_TTL_MS) set = await loadJwks(url, fetcher);
  let key = set.keys.get(kid) ?? null;
  if (!key && Date.now() - set.at > JWKS_MIN_REFRESH_MS) key = (await loadJwks(url, fetcher)).keys.get(kid) ?? null;
  return key;
}

export type KeyResolver = (provider: SsoProvider, kid: string) => Promise<KeyObject | null>;

export const defaultKeyResolver: KeyResolver = (_provider, kid) => jwksKey(MS_JWKS_URL, kid);

// ---- id_token -----------------------------------------------------------------------------------------------------

export type VerifyOptions = { clientId: string; nonce: string; tenantId: string; now?: Date };

export type SsoIdentity = { provider: SsoProvider; email: string; subject: string; tenantId: string };

export async function verifyIdToken(idToken: string, opts: VerifyOptions, resolveKey: KeyResolver = defaultKeyResolver): Promise<SsoIdentity> {
  const decoded = jwt.decode(idToken, { complete: true });
  if (!decoded || typeof decoded === "string" || typeof decoded.payload === "string") throw new SsoError("bad_token");
  const header = decoded.header as { alg?: string; kid?: string };
  if (header.alg !== "RS256" || !header.kid) throw new SsoError("bad_token", "id_token must be RS256 with a kid");
  const key = await resolveKey("microsoft", header.kid);
  if (!key) throw new SsoError("bad_signature", "signing key not published by Microsoft");

  let claims: Record<string, any>;
  try {
    claims = jwt.verify(idToken, key, {
      algorithms: ["RS256"],
      audience: opts.clientId,
      clockTolerance: CLOCK_SKEW_S,
      ...(opts.now ? { clockTimestamp: Math.floor(opts.now.getTime() / 1000) } : {}),
    }) as Record<string, any>;
  } catch (err) {
    const name = (err as Error)?.name;
    const message = (err as Error)?.message ?? "";
    if (name === "TokenExpiredError" || /not active/i.test(message)) throw new SsoError("expired", message);
    if (/audience/i.test(message)) throw new SsoError("wrong_audience", message);
    if (/signature/i.test(message)) throw new SsoError("bad_signature", message);
    throw new SsoError("bad_token", message);
  }
  if (typeof claims.exp !== "number") throw new SsoError("expired", "id_token has no expiry");
  if (typeof claims.nonce !== "string" || claims.nonce !== opts.nonce) throw new SsoError("bad_nonce");

  const tid = String(claims.tid ?? "").toLowerCase();
  if (!isTenantId(tid) || String(claims.iss ?? "") !== `${MS_LOGIN_BASE}/${tid}/v2.0`) throw new SsoError("wrong_issuer");
  if (tid !== String(opts.tenantId).toLowerCase()) throw new SsoError("wrong_tenant");
  // The tenant is Boreal's own directory, so its email / sign-in name is one Boreal issued.
  const emailClaim = String(claims.email ?? "").trim().toLowerCase();
  const upn = String(claims.preferred_username ?? "").trim().toLowerCase();
  const email = emailClaim.includes("@") ? emailClaim : upn.includes("@") ? upn : "";
  if (!email) throw new SsoError("email_not_verified");
  return { provider: "microsoft", email, subject: String(claims.oid ?? claims.sub ?? ""), tenantId: tid };
}
