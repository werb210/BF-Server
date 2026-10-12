// BF_SERVER_STAFF_FACE_ID_v298
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";

const h = vi.hoisted(() => ({ poolQuery: vi.fn(), findAuthUserById: vi.fn() }));
// The production path of the auth router, so the real OTP rate limiter is live.
vi.mock("../../config/runtime.js", () => ({ isTest: false }));
vi.mock("../../db.js", async () => ({ ...(await vi.importActual<any>("../../db.js")), pool: { query: h.poolQuery }, dbQuery: h.poolQuery }));
vi.mock("../../modules/auth/auth.repo.js", async () => ({
  ...(await vi.importActual<any>("../../modules/auth/auth.repo.js")),
  findAuthUserById: h.findAuthUserById,
}));

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

  describe("routes are on the auth router with the OTP rate limit", () => {
    const token = () => jwt.sign({ sub: staff.id, role: "Staff", tokenVersion: 0, tv: 0 }, String(process.env.JWT_SECRET));
    let app: express.Express;
    beforeEach(async () => {
      const { query } = store();
      h.poolQuery.mockReset().mockImplementation(query);
      h.findAuthUserById.mockReset().mockResolvedValue({ ...staff, phoneNumber: "+14035550177" });
      vi.spyOn(console, "warn").mockImplementation(() => {});
      const router = (await import("../../routes/auth.js")).default;
      app = express();
      app.use(express.json());
      app.use("/api/auth", router);
    });
    afterEach(() => vi.restoreAllMocks());

    it("enroll and revoke require a signed-in user", async () => {
      expect((await request(app).post("/api/auth/device-sign-in/enroll").send({})).status).toBe(401);
      expect((await request(app).post("/api/auth/device-sign-in/revoke").send({})).status).toBe(401);
      expect(h.poolQuery).not.toHaveBeenCalled();
    });

    it("enroll, sign in with the device secret, then revoke", async () => {
      const enrolled = await request(app).post("/api/auth/device-sign-in/enroll").set("Authorization", `Bearer ${token()}`).send({ deviceLabel: "iPhone" });
      expect(enrolled.status).toBe(201);
      const { credentialId, secret } = enrolled.body;
      const signIn = await request(app).post("/api/auth/device-sign-in").send({ credentialId, secret });
      expect(signIn.status).toBe(200);
      expect((jwt.decode(signIn.body.data.token) as any).sub).toBe(staff.id);
      const revoked = await request(app).post("/api/auth/device-sign-in/revoke").set("Authorization", `Bearer ${token()}`).send({ credentialId });
      expect(revoked.body).toEqual({ revoked: 1 });
      expect((await request(app).post("/api/auth/device-sign-in").send({ credentialId, secret: signIn.body.data.secret })).status).toBe(401);
    });

    it("device sign-in is rate limited like OTP verify", async () => {
      const statuses: number[] = [];
      for (let i = 0; i < 12; i++) {
        statuses.push((await request(app).post("/api/auth/device-sign-in").send({ credentialId: ID, secret: "wrong" })).status);
      }
      expect(statuses.filter((s) => s === 401).length).toBeGreaterThan(0);
      expect(statuses.at(-1)).toBe(429);
    });
  });
});
