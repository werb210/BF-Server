// BF_SERVER_TEAMS_SERVER_IDENTITY_v1 (2026-11-20) - staff join Teams meetings as themselves even when the device
// cannot sign them in to Microsoft (the iPad app runs from capacitor://localhost, so Microsoft's sign-in window
// and redirect never come back to it, and staff landed in their own meeting's lobby as a guest).
// The server already holds each staff member's Microsoft refresh token (Connect Office 365). A Microsoft refresh
// token can be redeemed for another resource the same Entra app is consented for, so it is exchanged here for an
// Azure Communication Services token (Teams.ManageCalls / Teams.ManageChats), which ACS then swaps for that
// person's Teams identity. Nothing is stored except a rotated refresh token.
import type { Pool } from "pg";

export const ACS_TEAMS_RESOURCE_SCOPES =
  "https://auth.msft.communication.azure.com/Teams.ManageCalls https://auth.msft.communication.azure.com/Teams.ManageChats offline_access";

type Fetch = typeof fetch;

export async function teamsAadTokenForStaff(db: Pick<Pool, "query">, userId: string, doFetch: Fetch = fetch): Promise<string | null> {
  const tenant = String(process.env.MSAL_TENANT_ID ?? "").trim();
  const client = String(process.env.ACS_TEAMS_CLIENT_ID ?? process.env.MSAL_CLIENT_ID ?? "").trim();
  const secret = String(process.env.MSAL_CLIENT_SECRET ?? "").trim();
  if (!userId || !tenant || !client || !secret) {
    console.warn("[teams-in-app] server Teams sign-in not configured", { hasUser: !!userId, hasTenant: !!tenant, hasClient: !!client, hasSecret: !!secret });
    return null;
  }
  let refresh: string | null = null;
  try {
    const { rows } = await db.query<{ o365_refresh_token: string | null }>(`SELECT o365_refresh_token FROM users WHERE id = $1`, [userId]);
    refresh = rows[0]?.o365_refresh_token ?? null;
  } catch (err) {
    console.warn("[teams-in-app] could not read the stored Microsoft sign-in", { message: err instanceof Error ? err.message : String(err) });
    return null;
  }
  if (!refresh) {
    console.warn("[teams-in-app] no stored Microsoft sign-in for this staff member (Connect Office 365 in Settings)", { userId });
    return null;
  }
  try {
    const r = await doFetch(`https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: client, client_secret: secret, refresh_token: refresh, grant_type: "refresh_token", scope: ACS_TEAMS_RESOURCE_SCOPES }),
    });
    const text = await r.text();
    let tok: { access_token?: string; refresh_token?: string; error?: string; error_description?: string } = {};
    try { tok = JSON.parse(text); } catch { /* reported below */ }
    if (!r.ok || !tok.access_token) {
      console.warn("[teams-in-app] Microsoft refused the Teams token from the stored sign-in", { status: r.status, error: tok.error ?? null, description: String(tok.error_description ?? text).slice(0, 300) });
      return null;
    }
    if (tok.refresh_token && tok.refresh_token !== refresh) {
      await db.query(`UPDATE users SET o365_refresh_token = $2 WHERE id = $1`, [userId, tok.refresh_token]).catch((err: unknown) =>
        console.warn("[teams-in-app] could not save the rotated Microsoft sign-in", { message: err instanceof Error ? err.message : String(err) }));
    }
    return tok.access_token;
  } catch (err) {
    console.warn("[teams-in-app] Microsoft token request failed", { message: err instanceof Error ? err.message : String(err) });
    return null;
  }
}
