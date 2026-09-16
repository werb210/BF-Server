// BF_SERVER_STAFF_FACE_ID_v298
// Face ID sign-in for the Boreal Dialer (staff). Same shape as client Face ID
// sign-in, with staff-grade checks on every use: the account must still be an
// active, enabled staff account, and its token_version must not have changed
// since the phone enrolled (so disabling a user or forcing sign-out ends it).
import crypto from "node:crypto";

type Query = (sql: string, params: unknown[]) => Promise<{ rows: any[]; rowCount?: number | null }>;

export type StaffUser = { id: string; role?: string | null; disabled?: boolean | null; active?: boolean | null; tokenVersion?: number | null; lockedUntil?: string | Date | null };

export const hashSecret = (secret: string) => crypto.createHash("sha256").update(secret).digest("hex");
const newSecret = () => crypto.randomBytes(32).toString("base64url");

export function isActiveStaff(user: StaffUser | null): boolean {
  if (!user || !user.role || user.disabled || user.active === false) return false;
  if (user.lockedUntil && new Date(user.lockedUntil).getTime() > Date.now()) return false;
  return true;
}

export async function enrollStaffDevice(query: Query, user: StaffUser, deviceLabel: string | null) {
  const secret = newSecret();
  const r = await query(
    `INSERT INTO staff_device_credentials (user_id, secret_hash, token_version, device_label) VALUES ($1, $2, $3, $4) RETURNING id::text AS id`,
    [user.id, hashSecret(secret), Number(user.tokenVersion ?? 0), deviceLabel ? deviceLabel.slice(0, 80) : null],
  );
  return { credentialId: String(r.rows[0].id), secret };
}

export type StaffSignIn = { ok: true; userId: string; secret: string } | { ok: false; reason: "invalid" | "expired" | "account_inactive" };

export async function verifyStaffDevice(
  query: Query,
  credentialId: string,
  secret: string,
  loadUser: (id: string) => Promise<StaffUser | null>,
): Promise<StaffSignIn> {
  if (!/^[0-9a-f-]{36}$/i.test(credentialId) || !secret) return { ok: false, reason: "invalid" };
  const r = await query(
    `SELECT id::text AS id, user_id::text AS user_id, secret_hash, token_version, expires_at, revoked_at FROM staff_device_credentials WHERE id::text = $1 LIMIT 1`,
    [credentialId],
  );
  const row = r.rows[0];
  const given = Buffer.from(hashSecret(secret));
  const stored = Buffer.from(String(row?.secret_hash ?? ""));
  if (!row || row.revoked_at || given.length !== stored.length || !crypto.timingSafeEqual(given, stored)) return { ok: false, reason: "invalid" };
  if (new Date(row.expires_at).getTime() < Date.now()) return { ok: false, reason: "expired" };
  const user = await loadUser(row.user_id);
  if (!isActiveStaff(user) || Number(user!.tokenVersion ?? 0) !== Number(row.token_version ?? 0)) {
    await query(`UPDATE staff_device_credentials SET revoked_at = now() WHERE id::text = $1`, [credentialId]);
    return { ok: false, reason: "account_inactive" };
  }
  const rotated = newSecret();
  const upd = await query(
    `UPDATE staff_device_credentials SET secret_hash = $2, last_used_at = now() WHERE id::text = $1 AND secret_hash = $3 AND revoked_at IS NULL RETURNING id`,
    [credentialId, hashSecret(rotated), row.secret_hash],
  );
  if (!upd.rows.length) return { ok: false, reason: "invalid" };
  return { ok: true, userId: row.user_id, secret: rotated };
}

export async function revokeStaffDevices(query: Query, userId: string, credentialId?: string | null) {
  const r = await query(
    `UPDATE staff_device_credentials SET revoked_at = now()
      WHERE user_id::text = $1 AND revoked_at IS NULL AND ($2::text IS NULL OR id::text = $2)
      RETURNING id`,
    [userId, credentialId ?? null],
  );
  return r.rows.length;
}
