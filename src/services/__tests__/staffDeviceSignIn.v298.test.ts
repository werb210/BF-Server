// BF_SERVER_STAFF_FACE_ID_v298
import { describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import { enrollStaffDevice, hashSecret, isActiveStaff, revokeStaffDevices, verifyStaffDevice } from "../staffDeviceSignIn.js";

const ID = "22222222-2222-2222-2222-222222222222";
const staff = { id: "33333333-3333-3333-3333-333333333333", role: "Staff", active: true, disabled: false, tokenVersion: 4 };

function store() {
  const rows = new Map<string, any>();
  const query = vi.fn(async (sql: string, p: any[]) => {
    if (sql.startsWith("INSERT INTO staff_device_credentials")) { rows.set(ID, { id: ID, user_id: p[0], secret_hash: p[1], token_version: p[2], expires_at: new Date(Date.now() + 86400e3), revoked_at: null }); return { rows: [{ id: ID }] }; }
    if (sql.startsWith("SELECT id::text AS id, user_id")) return { rows: rows.has(p[0]) ? [rows.get(p[0])] : [] };
    if (sql.startsWith("UPDATE staff_device_credentials SET secret_hash")) { const r = rows.get(p[0]); if (!r || r.secret_hash !== p[2] || r.revoked_at) return { rows: [] }; r.secret_hash = p[1]; return { rows: [{ id: ID }] }; }
    if (sql.startsWith("UPDATE staff_device_credentials SET revoked_at")) { const r = rows.get(ID); if (r) r.revoked_at = new Date(); return { rows: r ? [{ id: ID }] : [] }; }
    return { rows: [] };
  });
  return { rows, query };
}

describe("staff Face ID sign-in", () => {
  it("only active staff accounts qualify", () => {
    expect(isActiveStaff(staff)).toBe(true);
    expect(isActiveStaff({ ...staff, disabled: true })).toBe(false);
    expect(isActiveStaff({ ...staff, active: false })).toBe(false);
    expect(isActiveStaff({ ...staff, lockedUntil: new Date(Date.now() + 60_000) })).toBe(false);
    expect(isActiveStaff(null)).toBe(false);
  });

  it("stores a hash, signs in once per secret, and rotates", async () => {
    const { rows, query } = store();
    const { credentialId, secret } = await enrollStaffDevice(query as any, staff, "iPhone");
    expect(rows.get(ID).secret_hash).toBe(hashSecret(secret));
    const r = await verifyStaffDevice(query as any, credentialId, secret, async () => staff);
    expect(r).toMatchObject({ ok: true, userId: staff.id });
    expect((await verifyStaffDevice(query as any, credentialId, secret, async () => staff)).ok).toBe(false);
  });

  it("ends Face ID sign-in when the account is disabled or signed out everywhere", async () => {
    const a = store();
    const e1 = await enrollStaffDevice(a.query as any, staff, null);
    expect(await verifyStaffDevice(a.query as any, e1.credentialId, e1.secret, async () => ({ ...staff, disabled: true }))).toEqual({ ok: false, reason: "account_inactive" });
    expect(a.rows.get(ID).revoked_at).toBeTruthy();

    const b = store();
    const e2 = await enrollStaffDevice(b.query as any, staff, null);
    expect(await verifyStaffDevice(b.query as any, e2.credentialId, e2.secret, async () => ({ ...staff, tokenVersion: 5 }))).toEqual({ ok: false, reason: "account_inactive" });
  });

  it("revokes on sign-out", async () => {
    const { rows, query } = store();
    const { credentialId, secret } = await enrollStaffDevice(query as any, staff, null);
    expect(await revokeStaffDevices(query as any, staff.id, credentialId)).toBe(1);
    expect((await verifyStaffDevice(query as any, credentialId, secret, async () => staff)).ok).toBe(false);
    expect(rows.get(ID).revoked_at).toBeTruthy();
  });

  it("routes are on the auth router with the OTP rate limit", () => {
    const auth = fs.readFileSync("src/routes/auth.ts", "utf8");
    expect(auth).toContain('router.post("/device-sign-in", otpVerifyLimiter');
    expect(auth).toContain('router.post("/device-sign-in/enroll", requireAuth');
    expect(auth).toContain('router.post("/device-sign-in/revoke", requireAuth');
  });
});
