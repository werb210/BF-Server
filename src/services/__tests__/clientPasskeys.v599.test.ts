// BF_SERVER_BLOCK_v599
import { describe, expect, it, vi, beforeEach } from "vitest";
import jwt from "jsonwebtoken";

const sw = vi.hoisted(() => ({
  generateRegistrationOptions: vi.fn(async (o: any) => ({ challenge: "reg-challenge", rp: { id: o.rpID }, excludeCredentials: o.excludeCredentials })),
  verifyRegistrationResponse: vi.fn(async () => ({ verified: true, registrationInfo: { credential: { id: "cred-1", publicKey: new Uint8Array([1, 2, 3]), counter: 0, transports: ["internal"] } } })),
  generateAuthenticationOptions: vi.fn(async () => ({ challenge: "login-challenge" })),
  verifyAuthenticationResponse: vi.fn(async () => ({ verified: true, authenticationInfo: { newCounter: 5 } })),
}));
vi.mock("@simplewebauthn/server", () => sw);

import { listPasskeys, loginOptions, loginWithPasskey, passkeyConfig, registerPasskey, registrationOptions, removePasskey } from "../clientPasskeys.js";

const SECRET = "test-jwt-secret-123";
const PHONE = "+17805551212";
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");

function db() {
  const challenges: any[] = [];
  const passkeys: any[] = [];
  const query = vi.fn(async (sql: string, p: any[]) => {
    if (sql.startsWith("DELETE FROM client_passkey_challenges WHERE expires_at")) return { rows: [] };
    if (sql.startsWith("INSERT INTO client_passkey_challenges")) { challenges.push({ challenge: p[0], phone: sql.includes("'register'") ? p[1] : null, kind: sql.includes("'register'") ? "register" : "login" }); return { rows: [] }; }
    if (sql.startsWith("SELECT challenge FROM client_passkey_challenges WHERE phone")) return { rows: challenges.filter((c) => c.phone === p[0] && c.kind === "register").slice(-1) };
    if (sql.startsWith("SELECT challenge FROM client_passkey_challenges WHERE challenge")) return { rows: challenges.filter((c) => c.challenge === p[0] && c.kind === "login") };
    if (sql.startsWith("DELETE FROM client_passkey_challenges WHERE phone")) { for (let i = challenges.length - 1; i >= 0; i--) if (challenges[i].phone === p[0]) challenges.splice(i, 1); return { rows: [] }; }
    if (sql.startsWith("DELETE FROM client_passkey_challenges WHERE challenge")) { const i = challenges.findIndex((c) => c.challenge === p[0]); if (i >= 0) challenges.splice(i, 1); return { rows: [] }; }
    if (sql.startsWith("SELECT credential_id, transports FROM client_passkeys")) return { rows: passkeys.filter((k) => k.phone === p[0] && !k.revoked_at) };
    if (sql.startsWith("INSERT INTO client_passkeys")) { passkeys.push({ id: "11111111-1111-1111-1111-111111111111", phone: p[0], credential_id: p[1], public_key: p[2], counter: p[3], transports: p[4], device_label: p[5], revoked_at: null }); return { rows: [] }; }
    if (sql.startsWith("SELECT phone, credential_id")) return { rows: passkeys.filter((k) => k.credential_id === p[0] && !k.revoked_at) };
    if (sql.startsWith("UPDATE client_passkeys SET counter")) { const k = passkeys.find((x) => x.credential_id === p[1]); if (k) k.counter = p[0]; return { rows: [] }; }
    if (sql.startsWith("SELECT id::text AS id, device_label")) return { rows: passkeys.filter((k) => k.phone === p[0] && !k.revoked_at) };
    if (sql.startsWith("UPDATE client_passkeys SET revoked_at")) { const k = passkeys.find((x) => x.phone === p[0] && x.id === p[1] && !x.revoked_at); if (k) k.revoked_at = new Date(); return { rows: k ? [{ id: k.id }] : [] }; }
    if (sql.includes("FROM applications a")) return { rows: [{ id: "app-9" }] };
    return { rows: [] };
  });
  return { query, challenges, passkeys };
}

beforeEach(() => { vi.clearAllMocks(); });

describe("client passkeys", () => {
  it("uses the client domain, never the staff one", () => {
    expect(passkeyConfig({} as any)).toEqual({ rpID: "client.boreal.financial", rpName: "Boreal Financial", origins: ["https://client.boreal.financial"] });
  });

  it("registers a passkey against the signed-in phone and consumes the challenge", async () => {
    const { query, challenges, passkeys } = db();
    const opts: any = await registrationOptions(query as any, PHONE);
    expect(opts.challenge).toBe("reg-challenge");
    expect(await registerPasskey(query as any, PHONE, { id: "cred-1", deviceLabel: "Chrome on Mac" })).toEqual({ ok: true });
    expect(passkeys[0]).toMatchObject({ phone: PHONE, credential_id: "cred-1", device_label: "Chrome on Mac" });
    expect(challenges).toHaveLength(0);
    expect(await registerPasskey(query as any, PHONE, {})).toEqual({ ok: false, error: "no_pending_challenge" });
  });

  it("signs in with a client session for the passkey's phone, one use per challenge", async () => {
    const { query, passkeys } = db();
    await registrationOptions(query as any, PHONE);
    await registerPasskey(query as any, PHONE, { id: "cred-1" });
    await loginOptions(query as any);
    const body = { id: "cred-1", response: { clientDataJSON: b64({ challenge: "login-challenge" }) } };
    const r: any = await loginWithPasskey(query as any, body, SECRET);
    expect(r.ok).toBe(true);
    const claims = jwt.verify(r.token, SECRET) as any;
    expect(claims).toMatchObject({ role: "client", phone: PHONE, isClient: true });
    expect(r.submittedApplicationId).toBe("app-9");
    expect(passkeys[0].counter).toBe(5);
    expect(await loginWithPasskey(query as any, body, SECRET)).toEqual({ ok: false, error: "challenge_expired" });
  });

  it("rejects unknown, removed and unverifiable passkeys", async () => {
    const { query, passkeys } = db();
    await registrationOptions(query as any, PHONE);
    await registerPasskey(query as any, PHONE, { id: "cred-1" });
    await loginOptions(query as any);
    const body = { id: "cred-1", response: { clientDataJSON: b64({ challenge: "login-challenge" }) } };
    expect(await loginWithPasskey(query as any, { ...body, id: "nope" }, SECRET)).toEqual({ ok: false, error: "unknown_credential" });
    sw.verifyAuthenticationResponse.mockRejectedValueOnce(new Error("bad signature"));
    expect(await loginWithPasskey(query as any, body, SECRET)).toEqual({ ok: false, error: "verification_failed" });
    expect(await removePasskey(query as any, "+10000000000", passkeys[0].id)).toBe(0);
    expect(await listPasskeys(query as any, PHONE)).toHaveLength(1);
    expect(await removePasskey(query as any, PHONE, passkeys[0].id)).toBe(1);
    expect(await loginWithPasskey(query as any, body, SECRET)).toEqual({ ok: false, error: "unknown_credential" });
  });
});
