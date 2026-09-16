// BF_SERVER_CLIENT_FACE_ID_v296
import { describe, expect, it, vi } from "vitest";
import jwt from "jsonwebtoken";
import fs from "node:fs";
import { clientPhoneFromAuth, enrollDevice, hashSecret, revokeDevices, signInWithDevice } from "../clientDeviceSignIn.js";

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

  it("is mounted in the guarded client router", () => {
    const idx = fs.readFileSync("src/routes/client/index.ts", "utf8");
    expect(idx).toContain("router.use(deviceSignInRouter);");
    expect(fs.readFileSync("src/routes/client/deviceSignIn.ts", "utf8")).toContain('router.post("/device-sign-in", signInLimiter');
  });
});
