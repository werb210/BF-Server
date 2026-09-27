// BF_SERVER_BLOCK_v599 - client passkeys.
// A passkey lets a client sign in to client.boreal.financial in a browser with
// Face ID, Touch ID or Windows Hello instead of a texted code. The phone app
// already has its own Face ID sign-in (clientDeviceSignIn.ts); passkeys cover
// the browser. Sign-in issues exactly the client session the text code does.
import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from "@simplewebauthn/server";
import { clientTokenFor, submittedApplicationFor } from "./clientDeviceSignIn.js";

type Query = (sql: string, params: unknown[]) => Promise<{ rows: any[]; rowCount?: number | null }>;

export function passkeyConfig(env: NodeJS.ProcessEnv = process.env) {
  const rpID = env.CLIENT_WEBAUTHN_RP_ID || "client.boreal.financial";
  const origins = (env.CLIENT_WEBAUTHN_ORIGINS || `https://${rpID}`).split(",").map((s) => s.trim()).filter(Boolean);
  return { rpID, rpName: env.CLIENT_WEBAUTHN_RP_NAME || "Boreal Financial", origins };
}

async function purge(query: Query) {
  await query(`DELETE FROM client_passkey_challenges WHERE expires_at < now()`, []).catch((err: any) =>
    console.warn("[client-passkeys] challenge purge failed", { message: err?.message }));
}

export async function registrationOptions(query: Query, phone: string) {
  const { rpID, rpName } = passkeyConfig();
  const existing = await query(
    `SELECT credential_id, transports FROM client_passkeys WHERE phone = $1 AND revoked_at IS NULL`, [phone]);
  const options = await generateRegistrationOptions({
    rpName, rpID,
    userName: phone,
    userDisplayName: phone,
    userID: new TextEncoder().encode(`client:${phone}`),
    attestationType: "none",
    excludeCredentials: existing.rows.map((c: any) => ({ id: c.credential_id, transports: c.transports ?? undefined })),
    authenticatorSelection: { residentKey: "required", requireResidentKey: true, userVerification: "preferred" },
  });
  await purge(query);
  await query(`INSERT INTO client_passkey_challenges (challenge, phone, kind) VALUES ($1, $2, 'register')`, [options.challenge, phone]);
  return options;
}

export async function registerPasskey(query: Query, phone: string, body: any) {
  const { rpID, origins } = passkeyConfig();
  const ch = await query(
    `SELECT challenge FROM client_passkey_challenges WHERE phone = $1 AND kind = 'register' AND expires_at > now() ORDER BY created_at DESC LIMIT 1`,
    [phone]);
  const challenge = ch.rows[0]?.challenge;
  if (!challenge) return { ok: false as const, error: "no_pending_challenge" };
  let v: any;
  try {
    v = await verifyRegistrationResponse({ response: body, expectedChallenge: challenge, expectedOrigin: origins, expectedRPID: rpID, requireUserVerification: false });
  } catch (err: any) {
    console.warn("[client-passkeys] register verify failed", { detail: err?.message, expectedRPID: rpID });
    return { ok: false as const, error: "verification_failed" };
  }
  if (!v?.verified || !v.registrationInfo) return { ok: false as const, error: "not_verified" };
  const cred = v.registrationInfo.credential;
  const label = typeof body?.deviceLabel === "string" ? body.deviceLabel.slice(0, 80) : null;
  await query(
    `INSERT INTO client_passkeys (phone, credential_id, public_key, counter, transports, device_label)
     VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (credential_id) DO NOTHING`,
    [phone, cred.id, Buffer.from(cred.publicKey).toString("base64url"), cred.counter ?? 0, cred.transports ?? null, label]);
  await query(`DELETE FROM client_passkey_challenges WHERE phone = $1 AND kind = 'register'`, [phone]);
  return { ok: true as const };
}

export async function loginOptions(query: Query) {
  const { rpID } = passkeyConfig();
  const options = await generateAuthenticationOptions({ rpID, userVerification: "preferred" });
  await purge(query);
  await query(`INSERT INTO client_passkey_challenges (challenge, kind) VALUES ($1, 'login')`, [options.challenge]);
  return options;
}

export type PasskeyLogin =
  | { ok: true; token: string; hasSubmittedApplication: boolean; submittedApplicationId: string | null }
  | { ok: false; error: string };

export async function loginWithPasskey(query: Query, body: any, jwtSecret: string): Promise<PasskeyLogin> {
  const { rpID, origins } = passkeyConfig();
  if (!body?.id || !body?.response?.clientDataJSON) return { ok: false, error: "invalid_request" };
  const r = await query(
    `SELECT phone, credential_id, public_key, counter, transports FROM client_passkeys WHERE credential_id = $1 AND revoked_at IS NULL LIMIT 1`,
    [String(body.id)]);
  const cred = r.rows[0];
  if (!cred) return { ok: false, error: "unknown_credential" };
  let challenge: string | undefined;
  try {
    const clientData = JSON.parse(Buffer.from(String(body.response.clientDataJSON), "base64url").toString("utf8"));
    const c = await query(
      `SELECT challenge FROM client_passkey_challenges WHERE challenge = $1 AND kind = 'login' AND expires_at > now() LIMIT 1`,
      [String(clientData?.challenge ?? "")]);
    challenge = c.rows[0]?.challenge;
  } catch { /* malformed clientDataJSON - treated as no challenge */ }
  if (!challenge) return { ok: false, error: "challenge_expired" };
  let v: any;
  try {
    v = await verifyAuthenticationResponse({
      response: body, expectedChallenge: challenge, expectedOrigin: origins, expectedRPID: rpID, requireUserVerification: false,
      credential: {
        id: cred.credential_id,
        publicKey: new Uint8Array(Buffer.from(cred.public_key, "base64url")),
        counter: Number(cred.counter) || 0,
        transports: cred.transports ?? undefined,
      },
    });
  } catch (err: any) {
    console.warn("[client-passkeys] login verify failed", { detail: err?.message, expectedRPID: rpID, expectedOrigin: origins });
    return { ok: false, error: "verification_failed" };
  }
  if (!v?.verified) return { ok: false, error: "not_verified" };
  // One use per challenge: delete it before issuing the session.
  await query(`DELETE FROM client_passkey_challenges WHERE challenge = $1`, [challenge]);
  await query(`UPDATE client_passkeys SET counter = $1, last_used_at = now() WHERE credential_id = $2`,
    [v.authenticationInfo?.newCounter ?? 0, cred.credential_id]);
  const submittedApplicationId = await submittedApplicationFor(query, cred.phone).catch((err: any) => {
    console.warn("[client-passkeys] submitted-application lookup failed", { message: err?.message });
    return null;
  });
  return { ok: true, token: clientTokenFor(cred.phone, jwtSecret), hasSubmittedApplication: !!submittedApplicationId, submittedApplicationId };
}

export async function listPasskeys(query: Query, phone: string) {
  const r = await query(
    `SELECT id::text AS id, device_label, created_at, last_used_at FROM client_passkeys WHERE phone = $1 AND revoked_at IS NULL ORDER BY created_at DESC`,
    [phone]);
  return r.rows;
}

export async function removePasskey(query: Query, phone: string, id: string) {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return 0;
  const r = await query(
    `UPDATE client_passkeys SET revoked_at = now() WHERE phone = $1 AND id::text = $2 AND revoked_at IS NULL RETURNING id`,
    [phone, id]);
  return r.rows.length;
}
