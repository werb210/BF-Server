// BF_SERVER_WEBAUTHN_v1 — passkey (WebAuthn) endpoints.
import { Router } from "express";
import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from "@simplewebauthn/server";
import { pool } from "../db.js";
import { requireAuth } from "../middleware/requireAuth.js";
import { signAccessToken } from "../auth/jwt.js";
import { ROLES, normalizeRole } from "../auth/roles.js";
import { fetchCapabilitiesForRole } from "../auth/capabilities.js";
import { findAuthUserById } from "../modules/auth/auth.repo.js";

const router = Router();
const RP_ID = process.env.WEBAUTHN_RP_ID || "staff.boreal.financial";
const RP_NAME = process.env.WEBAUTHN_RP_NAME || "Boreal Financial";
const ORIGINS = (process.env.WEBAUTHN_ORIGINS || `https://${RP_ID}`)
  .split(",").map((s) => s.trim()).filter(Boolean);

function mintStaffToken(user: any): string {
  const role = normalizeRole(user.role ?? "") ?? ROLES.STAFF;
  const userSilos = Array.isArray(user.silos) ? (user.silos as string[]) : [];
  const userSilo = user.silo as string | undefined;
  return signAccessToken({
    sub: String(user.id),
    role,
    tokenVersion: user.tokenVersion ?? 0,
    capabilities: fetchCapabilitiesForRole(role),
    ...(user.phoneNumber ? { phone: user.phoneNumber } : {}),
    ...(userSilo ? { silo: userSilo } : {}),
    ...(userSilos.length ? { silos: userSilos } : {}),
  } as any);
}

async function purgeExpiredChallenges(): Promise<void> {
  try { await pool.query(`DELETE FROM webauthn_challenges WHERE expires_at < now()`); } catch { /* noop */ }
}

router.post("/register/options", requireAuth, async (req: any, res) => {
  const userId = req.user?.id;
  if (!userId) return res.status(401).json({ error: "unauthorized" });
  const user = await findAuthUserById(String(userId));
  if (!user) return res.status(404).json({ error: "user_not_found" });
  const existing = await pool
    .query<{ credential_id: string; transports: string[] | null }>(
      `SELECT credential_id, transports FROM webauthn_credentials WHERE user_id = $1`, [userId])
    .then((r) => r.rows).catch(() => []);
  const options = await generateRegistrationOptions({
    rpName: RP_NAME, rpID: RP_ID,
    userName: (user as any).email || (user as any).phoneNumber || String(user.id),
    userDisplayName: [(user as any).first_name, (user as any).last_name].filter(Boolean).join(" ") || undefined,
    userID: new TextEncoder().encode(String(user.id)),
    attestationType: "none",
    excludeCredentials: existing.map((c) => ({ id: c.credential_id, transports: (c.transports as any) ?? undefined })),
    authenticatorSelection: { residentKey: "preferred", userVerification: "preferred" },
  });
  await purgeExpiredChallenges();
  await pool.query(`INSERT INTO webauthn_challenges (challenge, user_id, kind) VALUES ($1, $2, 'register')`, [options.challenge, userId]);
  return res.json(options);
});

router.post("/register/verify", requireAuth, async (req: any, res) => {
  const userId = req.user?.id;
  if (!userId) return res.status(401).json({ error: "unauthorized" });
  const ch = await pool
    .query<{ challenge: string }>(
      `SELECT challenge FROM webauthn_challenges WHERE user_id = $1 AND kind = 'register' AND expires_at > now() ORDER BY created_at DESC LIMIT 1`, [userId])
    .then((r) => r.rows[0]).catch(() => undefined);
  if (!ch) return res.status(400).json({ error: "no_pending_challenge" });
  let verification: any;
  try {
    verification = await verifyRegistrationResponse({ response: req.body, expectedChallenge: ch.challenge, expectedOrigin: ORIGINS, expectedRPID: RP_ID });
  } catch (err: any) { return res.status(400).json({ error: "verification_failed", detail: err?.message }); }
  if (!verification.verified || !verification.registrationInfo) return res.status(400).json({ error: "not_verified" });
  const cred = verification.registrationInfo.credential;
  await pool.query(
    `INSERT INTO webauthn_credentials (user_id, credential_id, public_key, counter, transports, device_label)
     VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (credential_id) DO NOTHING`,
    [userId, cred.id, Buffer.from(cred.publicKey).toString("base64url"), cred.counter ?? 0, cred.transports ?? null,
     typeof req.body?.deviceLabel === "string" ? req.body.deviceLabel.slice(0, 120) : null]);
  await pool.query(`DELETE FROM webauthn_challenges WHERE user_id = $1 AND kind = 'register'`, [userId]);
  return res.json({ ok: true });
});

router.post("/login/options", async (_req, res) => {
  const options = await generateAuthenticationOptions({ rpID: RP_ID, userVerification: "preferred" });
  await purgeExpiredChallenges();
  await pool.query(`INSERT INTO webauthn_challenges (challenge, kind) VALUES ($1, 'login')`, [options.challenge]);
  return res.json(options);
});

router.post("/login/verify", async (req: any, res) => {
  const body = req.body;
  if (!body?.id || !body?.response?.clientDataJSON) return res.status(400).json({ error: "invalid_request" });
  const cred = await pool
    .query<{ user_id: string; credential_id: string; public_key: string; counter: string; transports: string[] | null }>(
      `SELECT user_id, credential_id, public_key, counter, transports FROM webauthn_credentials WHERE credential_id = $1`, [body.id])
    .then((r) => r.rows[0]).catch(() => undefined);
  if (!cred) return res.status(401).json({ error: "unknown_credential" });
  let issuedChallenge: string | undefined;
  try {
    const clientData = JSON.parse(Buffer.from(body.response.clientDataJSON, "base64url").toString("utf8"));
    issuedChallenge = await pool
      .query<{ challenge: string }>(
        `SELECT challenge FROM webauthn_challenges WHERE challenge = $1 AND kind = 'login' AND expires_at > now() LIMIT 1`, [clientData?.challenge])
      .then((r) => r.rows[0]?.challenge);
  } catch { /* fall through */ }
  if (!issuedChallenge) return res.status(401).json({ error: "challenge_expired" });
  let verification: any;
  try {
    verification = await verifyAuthenticationResponse({
      response: body, expectedChallenge: issuedChallenge, expectedOrigin: ORIGINS, expectedRPID: RP_ID,
      credential: {
        id: cred.credential_id,
        publicKey: new Uint8Array(Buffer.from(cred.public_key, "base64url")),
        counter: Number(cred.counter) || 0,
        transports: (cred.transports as any) ?? undefined,
      },
    });
  } catch (err: any) { return res.status(401).json({ error: "verification_failed", detail: err?.message }); }
  if (!verification.verified) return res.status(401).json({ error: "not_verified" });
  await pool.query(`UPDATE webauthn_credentials SET counter = $1, last_used_at = now() WHERE credential_id = $2`,
    [verification.authenticationInfo.newCounter ?? 0, cred.credential_id]);
  await pool.query(`DELETE FROM webauthn_challenges WHERE challenge = $1`, [issuedChallenge]);
  const user = await findAuthUserById(cred.user_id);
  if (!user || (user as any).disabled || !(user as any).active) return res.status(403).json({ error: "user_inactive" });
  return res.json({ status: "ok", data: { token: mintStaffToken(user) } });
});

export default router;
