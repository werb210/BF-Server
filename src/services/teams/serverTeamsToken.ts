// BF_SERVER_TEAMS_SERVER_IDENTITY_v1 (2026-11-20) - staff join Teams meetings as themselves even when the device
// cannot sign them in to Microsoft (the iPad app runs from capacitor://localhost, so Microsoft's sign-in window
// and redirect never come back to it, and staff landed in their own meeting's lobby as a guest).
// The server already holds each staff member's Microsoft refresh token (Connect Office 365). A Microsoft refresh
// token can be redeemed for another resource the same Entra app is consented for, so it is exchanged here for an
// Azure Communication Services token (Teams.ManageCalls / Teams.ManageChats), which ACS then swaps for that
// person's Teams identity. Nothing is stored except a rotated refresh token.
import type { Pool } from "pg";

export const ACS_TEAMS_RESOURCE_SCOPES =
  "https://auth.msft.communication.azure.com/Teams.ManageCalls https://auth.msft.communication.azure.com/Teams.ManageChats offline_access openid";

type Fetch = typeof fetch;

// Why the last stored-sign-in attempt for each staff member failed, so the portal can say so (no secrets).
export const lastTeamsSignInIssue = new Map<string, string>();
const issue = (userId: string, why: string): null => { if (userId) lastTeamsSignInIssue.set(userId, why.slice(0, 300)); return null; };

// The ACS token Microsoft returns is encrypted (five parts), so the person's Microsoft user id cannot be read from
// it; "openid" brings an id_token alongside, whose oid is that id (ACS still verifies the pair itself).
function oidFromIdToken(idToken: unknown): string | undefined {
  if (typeof idToken !== "string") return undefined;
  try {
    const part = idToken.split(".")[1] ?? "";
    const claims = JSON.parse(Buffer.from(part.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
    return typeof claims?.oid === "string" ? claims.oid : undefined;
  } catch { return undefined; }
}

async function oidFromGraph(db: Pick<Pool, "query">, userId: string): Promise<string | undefined> {
  try {
    const { getGraphForUser } = await import("../../modules/o365/graphClient.js");
    const graph = await getGraphForUser(db as any, userId);
    if (!graph) { console.warn("[teams-in-app] no Graph sign-in for this staff member"); return undefined; }
    const r = await graph.fetch("/me?$select=id");
    if (!r.ok) { console.warn("[teams-in-app] Graph /me refused", { status: r.status }); return undefined; }
    const me: any = await r.json();
    return typeof me?.id === "string" && /^[0-9a-f-]{36}$/i.test(me.id) ? me.id : undefined;
  } catch (err) {
    console.warn("[teams-in-app] Graph /me failed", { message: err instanceof Error ? err.message : String(err) });
    return undefined;
  }
}

export async function teamsAadTokenForStaff(db: Pick<Pool, "query">, userId: string, doFetch: Fetch = fetch): Promise<{ token: string; oid?: string } | null> {
  const tenant = String(process.env.MSAL_TENANT_ID ?? "").trim();
  const client = String(process.env.ACS_TEAMS_CLIENT_ID ?? process.env.MSAL_CLIENT_ID ?? "").trim();
  const secret = String(process.env.MSAL_CLIENT_SECRET ?? "").trim();
  if (!userId || !tenant || !client || !secret) {
    console.warn("[teams-in-app] server Teams sign-in not configured", { hasUser: !!userId, hasTenant: !!tenant, hasClient: !!client, hasSecret: !!secret });
    return issue(userId, `server not configured (tenant:${!!tenant} client:${!!client} secret:${!!secret})`);
  }
  let refresh: string | null = null;
  try {
    const { rows } = await db.query<{ o365_refresh_token: string | null }>(`SELECT o365_refresh_token FROM users WHERE id = $1`, [userId]);
    refresh = rows[0]?.o365_refresh_token ?? null;
  } catch (err) {
    console.warn("[teams-in-app] could not read the stored Microsoft sign-in", { message: err instanceof Error ? err.message : String(err) });
    return issue(userId, "could not read the stored Microsoft sign-in");
  }
  if (!refresh) {
    console.warn("[teams-in-app] no stored Microsoft sign-in for this staff member (Connect Office 365 in Settings)", { userId });
    return issue(userId, "no stored Microsoft sign-in (Connect Office 365 in Settings)");
  }
  try {
    const r = await doFetch(`https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: client, client_secret: secret, refresh_token: refresh, grant_type: "refresh_token", scope: ACS_TEAMS_RESOURCE_SCOPES }),
    });
    const text = await r.text();
    let tok: { access_token?: string; refresh_token?: string; id_token?: string; error?: string; error_description?: string } = {};
    try { tok = JSON.parse(text); } catch { /* reported below */ }
    if (!r.ok || !tok.access_token) {
      console.warn("[teams-in-app] Microsoft refused the Teams token from the stored sign-in", { status: r.status, error: tok.error ?? null, description: String(tok.error_description ?? text).slice(0, 300) });
      return issue(userId, `Microsoft refused (${r.status} ${tok.error ?? ""}): ${String(tok.error_description ?? text).split("\r")[0].slice(0, 220)}`);
    }
    if (tok.refresh_token && tok.refresh_token !== refresh) {
      await db.query(`UPDATE users SET o365_refresh_token = $2 WHERE id = $1`, [userId, tok.refresh_token]).catch((err: unknown) =>
        console.warn("[teams-in-app] could not save the rotated Microsoft sign-in", { message: err instanceof Error ? err.message : String(err) }));
    }
    lastTeamsSignInIssue.delete(userId);
    let oid = oidFromIdToken(tok.id_token);
    // BF_SERVER_TEAMS_OID_FROM_GRAPH_v1 - production: the refresh answer carried no readable user id, so ask Microsoft
    // Graph who this is (/me id is the Microsoft user id), with the same stored sign-in.
    if (!oid) oid = await oidFromGraph(db, userId);
    console.warn("[teams-in-app] stored sign-in gave a Teams token", { hasIdToken: !!tok.id_token, hasUserId: !!oid });
    return { token: tok.access_token, oid };
  } catch (err) {
    console.warn("[teams-in-app] Microsoft token request failed", { message: err instanceof Error ? err.message : String(err) });
    return issue(userId, "Microsoft token request failed: " + (err instanceof Error ? err.message : String(err)));
  }
}
