import type { Pool } from "pg";

// BF_SERVER_BLOCK_v337_GRAPH_AUTO_REFRESH_v1
// Microsoft Graph delegated-flow scopes. Must match what the portal's
// MSAL config requests at login (VITE_MSAL_SCOPES on the BF-portal SWA)
// and what the Azure AD app registration grants as Delegated permissions.
// Microsoft only returns a token with scopes the user originally consented
// to, so all three layers (this string, VITE_MSAL_SCOPES, and the app reg
// Delegated permissions) MUST list the same scope set or the refreshed
// token gets silently downgraded.
const REFRESH_SCOPE =
  "User.Read Mail.ReadWrite Mail.Send Mail.Send.Shared Calendars.ReadWrite Tasks.ReadWrite offline_access";

// Refresh window: refresh the access token proactively when fewer than
// EXPIRY_SKEW_MS milliseconds remain on it. Microsoft access tokens
// default to ~1 hour, so 60s is generous and avoids the boundary race.
const EXPIRY_SKEW_MS = 60_000;

type RefreshResult = {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: Date;
};

async function refreshAccessToken(refreshToken: string): Promise<RefreshResult | null> {
  const tenant = process.env.MSAL_TENANT_ID;
  const client = process.env.MSAL_CLIENT_ID;
  const secret = process.env.MSAL_CLIENT_SECRET;
  if (!tenant || !client || !secret) return null;
  const body = new URLSearchParams({
    client_id: client,
    client_secret: secret,
    refresh_token: refreshToken,
    grant_type: "refresh_token",
    scope: REFRESH_SCOPE,
  });
  const r = await fetch(
    `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    },
  );
  if (!r.ok) return null;
  const tok = (await r.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
  };
  if (!tok.access_token) return null;
  return {
    accessToken: tok.access_token,
    refreshToken: tok.refresh_token ?? null,
    expiresAt: new Date(Date.now() + (tok.expires_in ?? 3600) * 1000),
  };
}

async function persistRefreshedToken(
  db: Pool,
  userId: string,
  accessToken: string,
  refreshToken: string | null,
  expiresAt: Date,
): Promise<void> {
  // Write both expiry columns to stay compatible with the dual-column
  // setup written by /o365-tokens (BF_O365_DUAL_EXPIRY_v38).
  await db.query(
    `UPDATE users SET
       o365_access_token = $1,
       o365_refresh_token = COALESCE($2, o365_refresh_token),
       o365_access_token_expires_at = $3,
       o365_token_expires_at        = $3
     WHERE id = $4`,
    [accessToken, refreshToken, expiresAt, userId],
  );
}

export type GraphClient = {
  fetch: (path: string, init?: RequestInit) => Promise<Response>;
  accessToken: string;
};

export async function getGraphForUser(
  db: Pool,
  userId: string,
): Promise<GraphClient | null> {
  // BF_SERVER_BLOCK_v337_GRAPH_AUTO_REFRESH_v1
  // Pre-fix behavior: this function read o365_access_token verbatim and
  // returned it. No expiry check, no refresh, no 401 retry. When the
  // token expired (every 60 minutes) every Graph call 403'd until the
  // browser noticed and POSTed a fresh token. Inbox / calendar / tasks
  // appeared "permanently broken" but were really just expired.
  //
  // Post-fix behavior:
  //   1. Read access_token, refresh_token, AND expiry.
  //   2. If expiry is within 60s (or unknown), refresh proactively
  //      before returning the client.
  //   3. Wrap fetch() so any 401 from Graph triggers a one-shot
  //      refresh-and-retry. Belt-and-suspenders for cases where the
  //      proactive check is wrong (e.g. token revoked server-side).
  //   4. Persist the refreshed access_token + refresh_token back to
  //      the users row so the next request starts from a fresh state.
  const { rows } = await db.query<{
    o365_access_token: string | null;
    o365_refresh_token: string | null;
    o365_access_token_expires_at: Date | string | null;
  }>(
    `SELECT o365_access_token,
            o365_refresh_token,
            COALESCE(o365_access_token_expires_at, o365_token_expires_at) AS o365_access_token_expires_at
     FROM users
     WHERE id = $1`,
    [userId],
  );
  const row = rows[0];
  if (!row?.o365_access_token) return null;

  let currentToken: string = row.o365_access_token;
  const refreshToken = row.o365_refresh_token;
  const expiresAt = row.o365_access_token_expires_at
    ? new Date(row.o365_access_token_expires_at)
    : null;

  const expiresSoon =
    !expiresAt || expiresAt.getTime() - Date.now() < EXPIRY_SKEW_MS;
  if (expiresSoon && refreshToken) {
    const refreshed = await refreshAccessToken(refreshToken);
    if (refreshed) {
      currentToken = refreshed.accessToken;
      await persistRefreshedToken(
        db,
        userId,
        refreshed.accessToken,
        refreshed.refreshToken,
        refreshed.expiresAt,
      );
    }
  }

  const graphFetch = async (
    path: string,
    init: RequestInit = {},
  ): Promise<Response> => {
    const doFetch = (token: string) =>
      fetch(`https://graph.microsoft.com/v1.0${path}`, {
        ...init,
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          ...(init.headers as Record<string, string> | undefined),
        },
      });

    let resp = await doFetch(currentToken);
    if (resp.status === 401 && refreshToken) {
      const refreshed = await refreshAccessToken(refreshToken);
      if (refreshed) {
        currentToken = refreshed.accessToken;
        await persistRefreshedToken(
          db,
          userId,
          refreshed.accessToken,
          refreshed.refreshToken,
          refreshed.expiresAt,
        );
        resp = await doFetch(currentToken);
      }
    }
    return resp;
  };

  return {
    get accessToken() {
      return currentToken;
    },
    fetch: graphFetch,
  };
}
