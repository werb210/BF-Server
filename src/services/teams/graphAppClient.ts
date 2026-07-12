// BF_SERVER_TEAMS_TRANSCRIPT_POLLER_v1
// App-only (client_credentials) Graph client. The Teams transcript + recording
// endpoints are Application-permission only and are addressed as
//   /users/{organizerUpn}/onlineMeetings/{id}/transcripts
// so they cannot use the delegated per-user client in modules/o365/graphClient.ts.
// Uses the same MS_GRAPH_* env trio as services/email/graphSendService.ts, which
// is already proven working for the app-only submissions pipeline.
let cachedToken: { token: string; expiresAt: number } | null = null;

function envOrEmpty(k: string): string {
  return (process.env[k] ?? "").trim();
}

export function isAppGraphConfigured(): boolean {
  return Boolean(
    envOrEmpty("MS_GRAPH_TENANT_ID") &&
      envOrEmpty("MS_GRAPH_CLIENT_ID") &&
      envOrEmpty("MS_GRAPH_CLIENT_SECRET"),
  );
}

async function getAppGraphToken(): Promise<string> {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) {
    return cachedToken.token;
  }
  const tenant = envOrEmpty("MS_GRAPH_TENANT_ID");
  const clientId = envOrEmpty("MS_GRAPH_CLIENT_ID");
  const clientSecret = envOrEmpty("MS_GRAPH_CLIENT_SECRET");
  const url = `https://login.microsoftonline.com/${encodeURIComponent(tenant)}/oauth2/v2.0/token`;
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    grant_type: "client_credentials",
    scope: "https://graph.microsoft.com/.default",
  });
  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!resp.ok) {
    const txt = await resp.text().catch(() => "");
    throw new Error(`teams_graph_token_failed status=${resp.status} body=${txt.slice(0, 300)}`);
  }
  const json = (await resp.json()) as { access_token?: string; expires_in?: number };
  const token = String(json.access_token ?? "");
  if (!token) throw new Error("teams_graph_token_empty");
  const expiresIn = Number(json.expires_in ?? 3600);
  cachedToken = { token, expiresAt: Date.now() + expiresIn * 1000 };
  return token;
}

export async function graphAppFetch(
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const token = await getAppGraphToken();
  return fetch(`https://graph.microsoft.com/v1.0${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(init.headers as Record<string, string> | undefined),
    },
  });
}
