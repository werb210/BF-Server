// BF_SERVER_v852_CALC_QBO - the company's QuickBooks Online connection (OAuth 2.0, Intuit) and the Accounting API.
//
// One connection for the whole company (qbo_connections id 'company'). Access tokens last an hour and are renewed
// five minutes before they expire; Intuit rotates the refresh token on renewal and the new one is stored straight
// away. Both tokens are stored encrypted (qboCrypto.ts). Every call can be given its own fetch, so tests never reach
// Intuit.
import { pool } from "../../db.js";
import {
  QBO_AUTHORIZE_URL, QBO_MINOR_VERSION, QBO_REVOKE_URL, QBO_SCOPE, QBO_TOKEN_URL,
  qboApiBase, qboCredentials, qboEnvironment, qboRedirectUri,
} from "./qboConfig.js";
import { decryptToken, encryptToken } from "./qboCrypto.js";

export type Q = { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[]; rowCount?: number | null }> };
export type FetchLike = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<{
  ok: boolean; status: number; json: () => Promise<any>; text: () => Promise<string>;
}>;
export type QboDeps = { db?: Q; fetchImpl?: FetchLike; env?: Record<string, string | undefined>; now?: () => number };

export const CONNECTION_ID = "company";
const REFRESH_EARLY_MS = 5 * 60 * 1000;

const dbOf = (d?: QboDeps): Q => d?.db ?? (pool as unknown as Q);
const fetchOf = (d?: QboDeps): FetchLike => d?.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
const envOf = (d?: QboDeps) => d?.env ?? process.env;
const nowOf = (d?: QboDeps) => (d?.now ? d.now() : Date.now());

export class QboError extends Error {
  status: number;
  code: string | null;
  constructor(message: string, status = 0, code: string | null = null) {
    super(message);
    this.name = "QboError";
    this.status = status;
    this.code = code;
  }
}

/** The Intuit sign-in page for an Admin connecting the company file. */
export function authorizeUrl(state: string, env?: Record<string, string | undefined>): string {
  const params = new URLSearchParams({
    client_id: qboCredentials(env).clientId,
    response_type: "code",
    scope: QBO_SCOPE,
    redirect_uri: qboRedirectUri(env),
    state,
  });
  return QBO_AUTHORIZE_URL + "?" + params.toString();
}

function basicAuth(env?: Record<string, string | undefined>): string {
  const { clientId, clientSecret } = qboCredentials(env);
  return "Basic " + Buffer.from(clientId + ":" + clientSecret, "utf8").toString("base64");
}

type TokenSet = { access_token: string; refresh_token: string; expires_in?: number; x_refresh_token_expires_in?: number };

async function tokenRequest(form: Record<string, string>, deps?: QboDeps): Promise<TokenSet> {
  const res = await fetchOf(deps)(QBO_TOKEN_URL, {
    method: "POST",
    headers: { Authorization: basicAuth(envOf(deps)), Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(form).toString(),
  });
  if (!res.ok) {
    const detail = await res.text().catch((err: unknown) => { console.warn("[quickbooks] token error body unreadable", { message: (err as Error)?.message }); return ""; });
    throw new QboError("QuickBooks token request failed (" + res.status + "): " + detail.slice(0, 200), res.status, /invalid_grant/.test(detail) ? "invalid_grant" : null);
  }
  const tok = (await res.json()) as Partial<TokenSet>;
  if (!tok.access_token || !tok.refresh_token) throw new QboError("QuickBooks returned no tokens", res.status);
  return tok as TokenSet;
}

async function saveTokens(tok: TokenSet, extra: { realmId?: string; userId?: string | null; companyName?: string | null }, deps?: QboDeps): Promise<void> {
  const now = nowOf(deps);
  const env = envOf(deps);
  const accessExpires = new Date(now + Math.max(60, Number(tok.expires_in ?? 3600)) * 1000);
  const refreshExpires = tok.x_refresh_token_expires_in ? new Date(now + Number(tok.x_refresh_token_expires_in) * 1000) : null;
  if (extra.realmId) {
    await dbOf(deps).query(
      `INSERT INTO qbo_connections (id, realm_id, environment, access_token_enc, refresh_token_enc, access_expires_at, refresh_expires_at,
                                    connected_by, company_name, connected_at, first_connected_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now(), now(), now())
       ON CONFLICT (id) DO UPDATE SET realm_id = EXCLUDED.realm_id, environment = EXCLUDED.environment,
         access_token_enc = EXCLUDED.access_token_enc, refresh_token_enc = EXCLUDED.refresh_token_enc,
         access_expires_at = EXCLUDED.access_expires_at, refresh_expires_at = EXCLUDED.refresh_expires_at,
         connected_by = EXCLUDED.connected_by, company_name = EXCLUDED.company_name, connected_at = now(),
         first_connected_at = COALESCE(qbo_connections.first_connected_at, now()), updated_at = now()`,
      [CONNECTION_ID, extra.realmId, qboEnvironment(env), encryptToken(tok.access_token, env), encryptToken(tok.refresh_token, env),
        accessExpires, refreshExpires, extra.userId ?? null, extra.companyName ?? null],
    );
    return;
  }
  // A renewal: Intuit may hand back a new refresh token (rotation). Store it straight away.
  await dbOf(deps).query(
    `UPDATE qbo_connections SET access_token_enc = $2, refresh_token_enc = $3, access_expires_at = $4,
            refresh_expires_at = COALESCE($5, refresh_expires_at), updated_at = now()
      WHERE id = $1`,
    [CONNECTION_ID, encryptToken(tok.access_token, env), encryptToken(tok.refresh_token, env), accessExpires, refreshExpires],
  );
}

/** Callback step: trade the authorization code for tokens and store the connection. */
export async function exchangeCodeAndConnect(code: string, realmId: string, userId: string, deps?: QboDeps): Promise<void> {
  const tok = await tokenRequest({ grant_type: "authorization_code", code, redirect_uri: qboRedirectUri(envOf(deps)) }, deps);
  await saveTokens(tok, { realmId, userId, companyName: null }, deps);
  try {
    const info = await qboRequest("GET", "companyinfo/" + encodeURIComponent(realmId), undefined, deps);
    const name = info?.CompanyInfo?.CompanyName ?? info?.CompanyInfo?.LegalName ?? null;
    if (name) await dbOf(deps).query(`UPDATE qbo_connections SET company_name = $2, updated_at = now() WHERE id = $1`, [CONNECTION_ID, String(name).slice(0, 200)]);
  } catch (err) {
    // The connection works without the company name; it is only shown in Settings.
    console.warn("[quickbooks] company name lookup failed", { message: (err as Error)?.message });
  }
}

export type ConnectionRow = {
  realm_id: string; environment: string; access_token_enc: string; refresh_token_enc: string;
  access_expires_at: string | Date; refresh_expires_at: string | Date | null; connected_by: string | null;
  company_name: string | null; connected_at: string | Date; first_connected_at: string | Date | null;
};

export async function getConnection(deps?: QboDeps): Promise<ConnectionRow | null> {
  const r = await dbOf(deps).query(
    `SELECT realm_id, environment, access_token_enc, refresh_token_enc, access_expires_at, refresh_expires_at, connected_by,
            company_name, connected_at, first_connected_at
       FROM qbo_connections WHERE id = $1 LIMIT 1`,
    [CONNECTION_ID],
  );
  return (r.rows[0] as ConnectionRow | undefined) ?? null;
}

let refreshing: Promise<string> | null = null;

async function refreshAccessToken(conn: ConnectionRow, deps?: QboDeps): Promise<string> {
  const tok = await tokenRequest({ grant_type: "refresh_token", refresh_token: decryptToken(conn.refresh_token_enc, envOf(deps)) }, deps);
  await saveTokens(tok, {}, deps);
  console.info({ event: "qbo_token_refreshed", rotated: true });
  return tok.access_token;
}

/** A usable access token and the company id, renewing first when the token is about to expire. */
export async function accessToken(deps?: QboDeps, force = false): Promise<{ token: string; realmId: string }> {
  const conn = await getConnection(deps);
  if (!conn) throw new QboError("QuickBooks is not connected", 0, "not_connected");
  const expires = new Date(conn.access_expires_at).getTime();
  if (!force && Number.isFinite(expires) && expires - nowOf(deps) > REFRESH_EARLY_MS) {
    return { token: decryptToken(conn.access_token_enc, envOf(deps)), realmId: conn.realm_id };
  }
  // One renewal at a time in this process: two renewals with the same refresh token could lose the rotated one.
  if (!refreshing) refreshing = refreshAccessToken(conn, deps).finally(() => { refreshing = null; });
  return { token: await refreshing, realmId: conn.realm_id };
}

function faultMessage(body: any): { message: string; code: string | null } {
  const err = body?.Fault?.Error?.[0] ?? body?.fault?.error?.[0];
  if (!err) return { message: typeof body === "string" ? body.slice(0, 200) : "QuickBooks request failed", code: null };
  return { message: [err.Message ?? err.message, err.Detail ?? err.detail].filter(Boolean).join(": ").slice(0, 300), code: err.code ? String(err.code) : null };
}

/** One Accounting API call (path relative to /v3/company/{realmId}/). Renews the token once on a 401. */
export async function qboRequest(method: "GET" | "POST", path: string, body?: unknown, deps?: QboDeps, query: Record<string, string> = {}): Promise<any> {
  let attempt = 0;
  let auth = await accessToken(deps);
  for (;;) {
    const params = new URLSearchParams({ ...query, minorversion: QBO_MINOR_VERSION });
    const url = qboApiBase(envOf(deps)) + "/v3/company/" + encodeURIComponent(auth.realmId) + "/" + path + "?" + params.toString();
    const res = await fetchOf(deps)(url, {
      method,
      headers: { Authorization: "Bearer " + auth.token, Accept: "application/json", ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (res.status === 401 && attempt === 0) {
      attempt++;
      auth = await accessToken(deps, true);
      continue;
    }
    const text = await res.text();
    let parsed: any = null;
    try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
    if (!res.ok || parsed?.Fault) {
      const f = faultMessage(parsed);
      throw new QboError("QuickBooks " + method + " " + path.split("?")[0] + " failed (" + res.status + "): " + f.message, res.status, f.code);
    }
    return parsed;
  }
}

/** A QuickBooks query (select ... from Entity where ...). Returns the entity list. */
export async function qboQueryEntities(entity: string, where: string, deps?: QboDeps): Promise<any[]> {
  const out = await qboRequest("GET", "query", undefined, deps, { query: "select * " + "from " + entity + (where ? " where " + where : "") + " maxresults 10" });
  const list = out?.QueryResponse?.[entity];
  return Array.isArray(list) ? list : [];
}

/** Quote a value for a QuickBooks query string. */
export function qboQuote(value: string): string {
  return "'" + value.replace(/\\/g, "\\\\").replace(/'/g, "\\'") + "'";
}

/** Disconnect: revoke the refresh token at Intuit (which also ends the access token) and forget the connection. */
export async function revokeAndDisconnect(deps?: QboDeps): Promise<{ revoked: boolean }> {
  const conn = await getConnection(deps);
  if (!conn) return { revoked: false };
  let revoked = false;
  try {
    const res = await fetchOf(deps)(QBO_REVOKE_URL, {
      method: "POST",
      headers: { Authorization: basicAuth(envOf(deps)), Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({ token: decryptToken(conn.refresh_token_enc, envOf(deps)) }),
    });
    revoked = res.ok;
    if (!res.ok) console.warn("[quickbooks] revoke failed", { status: res.status });
  } catch (err) {
    console.warn("[quickbooks] revoke failed", { message: (err as Error)?.message });
  }
  await dbOf(deps).query(`DELETE FROM qbo_connections WHERE id = $1`, [CONNECTION_ID]);
  return { revoked };
}
