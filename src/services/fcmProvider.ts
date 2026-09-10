// BF_SERVER_FCM_DELIVERY_v1
// Firebase Cloud Messaging sender for Android client tokens.
import { createSign } from "node:crypto";
import { logInfo } from "../observability/logger.js";

export class FcmError extends Error {
  readonly invalidRegistration: boolean;

  constructor(message: string, invalidRegistration: boolean) {
    super(message);
    this.name = "FcmError";
    this.invalidRegistration = invalidRegistration;
  }
}

type ServiceAccount = { project_id: string; client_email: string; private_key: string };

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const SCOPE = "https://www.googleapis.com/auth/firebase.messaging";

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64")
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export class FirebaseFcmProvider {
  private cachedToken: string | null = null;
  private cachedUntil = 0;

  constructor(private readonly account: ServiceAccount) {}

  private async accessToken(): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    if (this.cachedToken && now < this.cachedUntil) return this.cachedToken;

    const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
    const claim = base64url(JSON.stringify({
      iss: this.account.client_email,
      scope: SCOPE,
      aud: TOKEN_URL,
      iat: now,
      exp: now + 3600,
    }));
    const signer = createSign("RSA-SHA256");
    signer.update(`${header}.${claim}`);
    const assertion = `${header}.${claim}.${base64url(signer.sign(this.account.private_key))}`;

    const response = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion,
      }).toString(),
    });
    if (!response.ok) throw new FcmError(`fcm_oauth_failed_${response.status}`, false);

    const body = (await response.json()) as { access_token?: string; expires_in?: number };
    if (!body.access_token) throw new FcmError("fcm_oauth_no_token", false);
    this.cachedToken = body.access_token;
    this.cachedUntil = now + Math.max(60, Number(body.expires_in ?? 3600)) - 60;
    return this.cachedToken;
  }

  async send(input: { token: string }, payload: {
    title: string; body: string; data?: Record<string, unknown>;
  }): Promise<void> {
    const bearer = await this.accessToken();
    const url = `https://fcm.googleapis.com/v1/projects/${encodeURIComponent(this.account.project_id)}/messages:send`;
    const data: Record<string, string> = {};
    for (const [key, value] of Object.entries(payload.data ?? {})) {
      data[key] = typeof value === "string" ? value : JSON.stringify(value);
    }

    const response = await fetch(url, {
      method: "POST",
      headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
      body: JSON.stringify({
        message: {
          token: input.token,
          notification: { title: payload.title, body: payload.body },
          data,
          android: { priority: "high", notification: { sound: "default" } },
        },
      }),
    });
    if (response.ok) return;

    const text = await response.text().catch(() => "");
    const invalid = response.status === 404
      || text.includes("UNREGISTERED")
      || text.includes("registration-token-not-registered");
    throw new FcmError(`fcm_send_failed_${response.status}:${text.slice(0, 200)}`, invalid);
  }
}

let provider: FirebaseFcmProvider | null = null;
let configured = false;

export function initializeFcmProvider(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.NODE_ENV === "test") return false;
  const raw = env.FIREBASE_SERVICE_ACCOUNT_JSON?.trim();
  if (!raw) {
    console.warn(JSON.stringify({ event: "fcm_not_configured", reason: "no_service_account" }));
    return false;
  }
  let parsed: ServiceAccount;
  try {
    parsed = JSON.parse(raw) as ServiceAccount;
  } catch {
    console.warn(JSON.stringify({ event: "fcm_not_configured", reason: "service_account_not_json" }));
    return false;
  }
  if (!parsed.project_id || !parsed.client_email || !parsed.private_key) {
    console.warn(JSON.stringify({ event: "fcm_not_configured", reason: "service_account_incomplete" }));
    return false;
  }
  parsed.private_key = parsed.private_key.replace(/\\n/g, "\n");
  provider = new FirebaseFcmProvider(parsed);
  configured = true;
  logInfo("fcm_initialized", { projectId: parsed.project_id });
  return true;
}

export function isFcmConfigured(): boolean { return configured; }
export function getFcmProvider(): FirebaseFcmProvider | null { return provider; }

/** Test seam. */
export function __setFcmProvider(p: FirebaseFcmProvider | null): void {
  provider = p;
  configured = p !== null;
}
