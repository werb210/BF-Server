// BF_SERVER_CLIENT_FACE_ID_v296
import { describe, expect, it, vi } from "vitest";
import jwt from "jsonwebtoken";
import express from "express";
import request from "supertest";
import { clientPhoneFromAuth, enrollDevice, hashSecret, revokeDevices, signInWithDevice } from "../clientDeviceSignIn.js";

// The client router's database: the device-credential store below, plus an application
// (APP_ID) that exists and is claimed, so the router-wide ownership guard would refuse
// any unsigned request naming it.
const APP_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const routerDb = vi.hoisted(() => ({ query: null as null | ((sql: string, p: any[]) => Promise<any>) }));
vi.mock("../../db.js", async (orig) => {
  const real: any = await orig();
  const q = async (sql: string, p: any[] = []) => {
    if (/FROM applications WHERE lower\(id::text\) = ANY/.test(sql)) return { rows: [{ id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" }] };
    if (sql.includes("WITH app_phones AS")) return { rows: [{ total: 1, mine: 0, known: 1 }] };
    return routerDb.query ? routerDb.query(sql, p) : { rows: [] };
  };
  const pool = { query: q, connect: async () => ({ query: q, release: () => undefined }) };
  return { ...real, dbQuery: q, runQuery: q, query: q, pool, db: pool, default: pool };
});

const SECRET = "test-jwt-secret-123";
const ID = "11111111-1111-1111-1111-111111111111";

function store() {
  const rows = new Map<string, any>();
  const query = vi.fn(async (sql: string, p: any[]) => {
    if (sql.startsWith("INSERT INTO client_device_credentials")) { rows.set(ID, { id: ID, phone: p[0], secret_hash: p[1], expires_at: new Date(Date.now() + 86400e3), revoked_at: null }); return { rows: [{ id: ID }] }; }
    if (sql.startsWith("SELECT id::text AS id, phone")) return { rows: rows.has(p[0]) ? [rows.get(p[0])] : [] };
    if (sql.startsWith("UPDATE client_device_credentials SET secret_hash")) {
      const r = rows.get(p[0]); if (!r || r.secret_hash !== p[2] || r.revoked_at) return { rows: [] };
      r.secret_hash = p[1]; return { rows: [{ id: ID }] };
    }
    if (sql.startsWith("UPDATE client_device_credentials SET revoked_at")) { const r = rows.get(ID); if (r) r.revoked_at = new Date(); return { rows: r ? [{ id: ID }] : [] }; }
    if (sql.includes("FROM applications a")) return { rows: [{ id: "app-9" }] };
    return { rows: [] };
  });
  return { rows, query };
}

describe("Face ID sign-in", () => {
  it("only a signed-in client session can enroll", () => {
    const client = jwt.sign({ role: "client", phone: "+17805551212" }, SECRET);
    const staff = jwt.sign({ role: "Staff", phone: "+17805551212" }, SECRET);
    expect(clientPhoneFromAuth(`Bearer ${client}`, SECRET)).toBe("+17805551212");
    expect(clientPhoneFromAuth(`Bearer ${staff}`, SECRET)).toBeNull();
    expect(clientPhoneFromAuth("", SECRET)).toBeNull();
  });

  it("stores only a hash, signs in with the secret, rotates it, and returns a 30-day client session", async () => {
    const { rows, query } = store();
    const { credentialId, secret } = await enrollDevice(query as any, "+17805551212", "iPhone");
    expect(rows.get(ID).secret_hash).toBe(hashSecret(secret));
    expect(rows.get(ID).secret_hash).not.toContain(secret);
    const r = await signInWithDevice(query as any, credentialId, secret, SECRET);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.secret).not.toBe(secret);
    expect(r.submittedApplicationId).toBe("app-9");
    const claims = jwt.verify(r.token, SECRET) as any;
    expect(claims).toMatchObject({ role: "client", phone: "+17805551212", isClient: true });
    expect(claims.exp - claims.iat).toBe(30 * 24 * 3600);
    expect((await signInWithDevice(query as any, credentialId, secret, SECRET)).ok).toBe(false);
  });

  it("refuses a wrong secret, a revoked device, and an expired one", async () => {
    const { rows, query } = store();
    const { credentialId, secret } = await enrollDevice(query as any, "+17805551212", null);
    expect(await signInWithDevice(query as any, credentialId, "wrong", SECRET)).toEqual({ ok: false, reason: "invalid" });
    rows.get(ID).expires_at = new Date(Date.now() - 1000);
    expect(await signInWithDevice(query as any, credentialId, secret, SECRET)).toEqual({ ok: false, reason: "expired" });
    rows.get(ID).expires_at = new Date(Date.now() + 1e9);
    expect(await revokeDevices(query as any, "+17805551212")).toBe(1);
    expect((await signInWithDevice(query as any, credentialId, secret, SECRET)).ok).toBe(false);
  });

  it("is mounted in the guarded client router", async () => {
    const prior = process.env.JWT_SECRET;
    process.env.JWT_SECRET = SECRET;
    const s = store();
    routerDb.query = s.query as any;
    try {
      const { default: clientRouter } = await import("../../routes/client/index.js");
      const app = express();
      app.set("trust proxy", true);
      app.use(express.json());
      app.use("/api/client", clientRouter);
      const client = `Bearer ${jwt.sign({ role: "client", phone: "+17805551212" }, SECRET)}`;

      // Enrolling needs the client session.
      expect((await request(app).post("/api/client/device-sign-in/enroll").send({})).status).toBe(401);
      const enrolled = await request(app).post("/api/client/device-sign-in/enroll").set("Authorization", client).send({ deviceLabel: "iPhone" });
      expect(enrolled.status).toBe(201);
      const { credentialId, secret } = enrolled.body;

      // Signing in is public and needs no application id - not even when the request names one it does not own.
      const signIn = await request(app).post("/api/client/device-sign-in").set("X-Forwarded-For", "198.51.100.50").send({ credentialId, secret, applicationId: APP_ID });
      expect(signIn.status).toBe(200);
      expect(jwt.verify(signIn.body.data.token, SECRET)).toMatchObject({ role: "client", phone: "+17805551212" });
      expect(signIn.body.data.submittedApplicationId).toBe("app-9");
      // The same unsigned request to a guarded client route is refused.
      expect((await request(app).post("/api/client/messages").send({ applicationId: APP_ID, body: "x" })).status).toBe(401);

      // The sign-in route carries its own limiter: 30 tries per 15 minutes per IP.
      const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      for (let i = 0; i < 30; i += 1) {
        const r = await request(app).post("/api/client/device-sign-in").set("X-Forwarded-For", "198.51.100.51").send({ credentialId, secret: "wrong" });
        expect(r.status).toBe(401);
      }
      expect((await request(app).post("/api/client/device-sign-in").set("X-Forwarded-For", "198.51.100.51").send({ credentialId, secret: "wrong" })).status).toBe(429);
      warn.mockRestore();
    } finally {
      routerDb.query = null;
      process.env.JWT_SECRET = prior;
    }
  }, 30_000);
});
