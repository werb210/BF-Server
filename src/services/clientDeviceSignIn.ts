// BF_SERVER_CLIENT_FACE_ID_v296
// Face ID sign-in for the client apps. After a normal text-code sign-in the app
// enrolls: the server returns a random device secret, the app keeps it in the
// Keychain behind Face ID. Next time, Face ID releases the secret, the server
// checks its hash, rotates it, and issues the same client session the text code
// would. Nothing biometric ever leaves the phone.
import crypto from "node:crypto";
import jwt from "jsonwebtoken";

type Query = (sql: string, params: unknown[]) => Promise<{ rows: any[]; rowCount?: number | null }>;

export const hashSecret = (secret: string) => crypto.createHash("sha256").update(secret).digest("hex");
const newSecret = () => crypto.randomBytes(32).toString("base64url");

export function clientTokenFor(phone: string, secret: string): string {
  return jwt.sign({ sub: `client:${phone}`, role: "client", phone, tokenVersion: 0, isClient: true }, secret, { expiresIn: "30d" });
}

/** A signed-in client session (role client, with a phone) is the only thing allowed to enroll a device. */
export function clientPhoneFromAuth(authHeader: unknown, jwtSecret: string | undefined): string | null {
  const auth = String(authHeader ?? "");
  if (!jwtSecret || !auth.startsWith("Bearer ")) return null;
  try {
    const claims = jwt.verify(auth.slice(7), jwtSecret) as Record<string, unknown>;
    if (claims.role !== "client" || typeof claims.phone !== "string" || !claims.phone) return null;
    return claims.phone;
  } catch {
    return null;
  }
}

export async function enrollDevice(query: Query, phone: string, deviceLabel: string | null) {
  const secret = newSecret();
  const r = await query(
    `INSERT INTO client_device_credentials (phone, secret_hash, device_label) VALUES ($1, $2, $3) RETURNING id::text AS id`,
    [phone, hashSecret(secret), deviceLabel ? deviceLabel.slice(0, 80) : null],
  );
  return { credentialId: String(r.rows[0].id), secret };
}

export async function submittedApplicationFor(query: Query, phone: string): Promise<string | null> {
  const r = await query(
    `SELECT a.id::text AS id
       FROM applications a
       LEFT JOIN application_contacts ac ON ac.application_id = a.id AND ac.role = 'applicant'
       LEFT JOIN contacts c   ON c.id = ac.contact_id
       LEFT JOIN contacts ac2 ON ac2.id = a.contact_id
      WHERE a.submitted_at IS NOT NULL
        AND length(regexp_replace($1, '[^0-9]', '', 'g')) >= 10
        AND (right(regexp_replace(coalesce(c.phone, ''), '[^0-9]', '', 'g'), 10) = right(regexp_replace($1, '[^0-9]', '', 'g'), 10)
          OR right(regexp_replace(coalesce(ac2.phone, ''), '[^0-9]', '', 'g'), 10) = right(regexp_replace($1, '[^0-9]', '', 'g'), 10))
      ORDER BY a.submitted_at DESC
      LIMIT 1`,
    [phone],
  );
  return r.rows[0]?.id ?? null;
}

export type SignInResult =
  | { ok: true; token: string; secret: string; hasSubmittedApplication: boolean; submittedApplicationId: string | null }
  | { ok: false; reason: "invalid" | "expired" };

export async function signInWithDevice(query: Query, credentialId: string, secret: string, jwtSecret: string): Promise<SignInResult> {
  if (!/^[0-9a-f-]{36}$/i.test(credentialId) || !secret) return { ok: false, reason: "invalid" };
  const r = await query(
    `SELECT id::text AS id, phone, secret_hash, expires_at, revoked_at FROM client_device_credentials WHERE id::text = $1 LIMIT 1`,
    [credentialId],
  );
  const row = r.rows[0];
  const given = Buffer.from(hashSecret(secret));
  const stored = Buffer.from(String(row?.secret_hash ?? ""));
  if (!row || row.revoked_at || given.length !== stored.length || !crypto.timingSafeEqual(given, stored)) return { ok: false, reason: "invalid" };
  if (new Date(row.expires_at).getTime() < Date.now()) return { ok: false, reason: "expired" };
  const rotated = newSecret();
  const upd = await query(
    `UPDATE client_device_credentials SET secret_hash = $2, last_used_at = now() WHERE id::text = $1 AND secret_hash = $3 AND revoked_at IS NULL RETURNING id`,
    [credentialId, hashSecret(rotated), row.secret_hash],
  );
  if (!upd.rows.length) return { ok: false, reason: "invalid" }; // a parallel sign-in already rotated it
  const submittedApplicationId = await submittedApplicationFor(query, row.phone).catch(() => null);
  return { ok: true, token: clientTokenFor(row.phone, jwtSecret), secret: rotated, hasSubmittedApplication: !!submittedApplicationId, submittedApplicationId };
}

export async function revokeDevices(query: Query, phone: string, credentialId?: string | null) {
  const r = await query(
    `UPDATE client_device_credentials SET revoked_at = now()
      WHERE phone = $1 AND revoked_at IS NULL AND ($2::text IS NULL OR id::text = $2)
      RETURNING id`,
    [phone, credentialId ?? null],
  );
  return r.rows.length;
}
