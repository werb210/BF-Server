// BF_SERVER_v875_SSO - "Sign in with Microsoft" end to end with a mocked database and a mocked Microsoft: the button is
// offered only when the server has the client secret AND an Admin switched it on; start -> callback -> one-time code
// -> a staff session (access token with a single sign-on session, which is strong, plus a refresh token); refusals
// for another tenant, a forged state, a reused state, a deactivated user, a lender account and an unknown email, each
// audit-logged; the id_token checks (signature, audience, nonce, issuer, tenant).
import { generateKeyPairSync } from "node:crypto";
import express from "express";
import cookieParser from "cookie-parser";
import jwt from "jsonwebtoken";
import request from "supertest";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const TENANT = "b585ab8e-bd39-449d-9210-479a9c989bb2";
const CLIENT = "c8890d6f-eb8f-4101-8336-5e8fca3303e0";

const db = vi.hoisted(() => ({
  settings: { microsoft_enabled: true } as Record<string, unknown> | null,
  states: [] as Array<{ state_hash: string; provider: string; code_verifier: string; nonce: string; consumed: boolean }>,
  handoffs: [] as Array<{ code_hash: string; user_id: string; provider: string; consumed: boolean }>,
  users: [] as Array<Record<string, unknown>>,
  sessions: [] as Array<{ id: string; user_id: string; method: string; strong: boolean }>,
  refresh: [] as Array<{ user_id: string; ksid: string | null }>,
  audits: [] as Array<Record<string, any>>,
}));

vi.mock("../../db.js", () => {
  const query = vi.fn(async (sql: string, params: any[] = []) => {
    if (/FROM boreal_settings WHERE key = \$1/i.test(sql)) return { rows: params[0] === "sso" && db.settings ? [{ value: db.settings }] : [] };
    if (/INSERT INTO boreal_settings/i.test(sql)) { db.settings = JSON.parse(params[1]); return { rows: [], rowCount: 1 }; }
    if (/INSERT INTO sso_login_states/i.test(sql)) {
      db.states.push({ state_hash: params[0], provider: params[1], code_verifier: params[2], nonce: params[3], consumed: false });
      return { rows: [], rowCount: 1 };
    }
    if (/UPDATE sso_login_states/i.test(sql)) {
      const row = db.states.find((s) => s.state_hash === params[0] && s.provider === params[1] && !s.consumed);
      if (!row) return { rows: [], rowCount: 0 };
      row.consumed = true;
      return { rows: [{ code_verifier: row.code_verifier, nonce: row.nonce }], rowCount: 1 };
    }
    if (/INSERT INTO sso_login_handoffs/i.test(sql)) {
      db.handoffs.push({ code_hash: params[0], user_id: params[1], provider: params[2], consumed: false });
      return { rows: [], rowCount: 1 };
    }
    if (/UPDATE sso_login_handoffs/i.test(sql)) {
      const row = db.handoffs.find((h) => h.code_hash === params[0] && !h.consumed);
      if (!row) return { rows: [], rowCount: 0 };
      row.consumed = true;
      return { rows: [{ user_id: row.user_id, provider: row.provider }], rowCount: 1 };
    }
    if (/FROM users WHERE lower\(email\) = \$1/i.test(sql)) return { rows: db.users.filter((u) => String(u.email).toLowerCase() === params[0]) };
    if (/FROM users WHERE id = \$1::uuid/i.test(sql)) return { rows: db.users.filter((u) => u.id === params[0]) };
    if (/from users u\s+where u\.id = \$1/i.test(sql)) {
      const u = db.users.find((x) => x.id === params[0]);
      return { rows: u ? [{ ...u, tokenVersion: 0, phoneNumber: null }] : [] };
    }
    if (/INSERT INTO user_sessions/i.test(sql)) {
      const id = `00000000-0000-4000-8000-${String(db.sessions.length + 1).padStart(12, "0")}`;
      db.sessions.push({ id, user_id: params[0], method: params[1], strong: params[2] });
      return { rows: [{ id }], rowCount: 1 };
    }
    if (/INSERT INTO staff_refresh_tokens/i.test(sql)) { db.refresh.push({ user_id: params[2], ksid: params[3] }); return { rows: [], rowCount: 1 }; }
    return { rows: [], rowCount: 0 };
  });
  return { pool: { query }, runQuery: query, dbQuery: query, db: { query } };
});
vi.mock("../../modules/audit/audit.service.js", () => ({
  recordAuditEvent: vi.fn(async (e: Record<string, any>) => { db.audits.push(e); }),
}));

const ENV_KEYS = ["MSAL_CLIENT_SECRET", "MSAL_CLIENT_ID", "MSAL_TENANT_ID", "SSO_MICROSOFT_TENANT", "PUBLIC_BASE_URL", "SSO_RETURN_URL", "PORTAL_URL"];
const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
process.env.MSAL_CLIENT_SECRET = "test-secret";
process.env.MSAL_CLIENT_ID = CLIENT;
process.env.MSAL_TENANT_ID = TENANT;
delete process.env.SSO_MICROSOFT_TENANT;
process.env.PUBLIC_BASE_URL = "https://server.boreal.financial";
process.env.SSO_RETURN_URL = "https://staff.boreal.financial/login";

import ssoRoutes, { pickStaffUser, setSsoFetcherForTests, setSsoKeyResolverForTests } from "../../routes/authSso.js";
import { buildAuthorizeUrl, providerConfig, SsoError, verifyIdToken } from "../oidc.js";
import { ssoAvailability } from "../settings.js";

const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
const otherKeys = generateKeyPairSync("rsa", { modulusLength: 2048 });
const app = express();
app.use(express.json());
app.use(cookieParser());
app.use("/api/auth/sso", ssoRoutes);

let claims: Record<string, unknown> = {};
function idToken(nonce: string, extra: Record<string, unknown> = {}, signer = keys.privateKey) {
  const now = Math.floor(Date.now() / 1000);
  return jwt.sign({
    iss: `https://login.microsoftonline.com/${TENANT}/v2.0`, aud: CLIENT, sub: "s-1", oid: "o-1", tid: TENANT,
    preferred_username: "ann@boreal.financial", nonce, iat: now, exp: now + 600, ...claims, ...extra,
  }, signer, { algorithm: "RS256", keyid: "k1" });
}

const ADMIN = { id: "11111111-1111-4111-8111-111111111111", email: "ann@boreal.financial", role: "Admin", active: true, disabled: false, deleted_at: null, status: "active", silo: "BF", silos: ["BF", "BI"] };

beforeEach(() => {
  db.settings = { microsoft_enabled: true };
  db.states = []; db.handoffs = []; db.sessions = []; db.refresh = []; db.audits = [];
  db.users = [{ ...ADMIN }];
  claims = {};
  setSsoKeyResolverForTests(async () => keys.publicKey);
  // Microsoft's token endpoint: answers with an id_token carrying the nonce of the newest stored state.
  setSsoFetcherForTests(async (url: string) => {
    expect(url).toBe(`https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/token`);
    const nonce = db.states[db.states.length - 1]?.nonce ?? "";
    return new Response(JSON.stringify({ id_token: idToken(nonce) }), { status: 200, headers: { "Content-Type": "application/json" } });
  });
});

afterAll(() => {
  for (const [k, v] of Object.entries(savedEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  setSsoKeyResolverForTests(undefined);
  setSsoFetcherForTests(undefined);
});

async function startSignIn() {
  const start = await request(app).get("/api/auth/sso/microsoft/start");
  expect(start.status).toBe(302);
  const loc = new URL(start.headers.location);
  const cookie = String(start.headers["set-cookie"]?.[0] ?? "").split(";")[0]!;
  return { state: loc.searchParams.get("state")!, cookie, loc };
}

describe("Microsoft sign-in is offered only when set up and switched on", () => {
  it("needs both the client secret and the Admin switch", async () => {
    expect((await request(app).get("/api/auth/sso/config")).body).toEqual({ ok: true, microsoft: true });
    db.settings = { microsoft_enabled: false };
    expect((await request(app).get("/api/auth/sso/config")).body.microsoft).toBe(false);
    expect(ssoAvailability({ microsoft_enabled: true }, { ...process.env, MSAL_CLIENT_SECRET: "" }).microsoft.available).toBe(false);
  });

  it("start redirects to Boreal's tenant with PKCE when on, and back to sign-in when off", async () => {
    const { loc } = await startSignIn();
    expect(loc.origin + loc.pathname).toBe(`https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/authorize`);
    expect(loc.searchParams.get("client_id")).toBe(CLIENT);
    expect(loc.searchParams.get("code_challenge_method")).toBe("S256");
    expect(loc.searchParams.get("redirect_uri")).toBe("https://server.boreal.financial/api/auth/sso/microsoft/callback");
    db.settings = { microsoft_enabled: false };
    const off = await request(app).get("/api/auth/sso/microsoft/start");
    expect(off.headers.location).toBe("https://staff.boreal.financial/login?sso_error=sso_off");
  });
});

describe("callback and exchange", () => {
  it("signs an active staff member in with a strong single sign-on session and a refresh token", async () => {
    const { state, cookie } = await startSignIn();
    const cb = await request(app).get(`/api/auth/sso/microsoft/callback?code=abc&state=${encodeURIComponent(state)}`).set("Cookie", cookie);
    expect(cb.status).toBe(302);
    const code = new URLSearchParams(new URL(cb.headers.location).hash.slice(1)).get("sso_code");
    expect(code).toBeTruthy();
    const ex = await request(app).post("/api/auth/sso/exchange").send({ code });
    expect(ex.status).toBe(200);
    const token = jwt.decode(ex.body.data.token) as Record<string, unknown>;
    expect(token.sub).toBe(ADMIN.id);
    expect(token.role).toBe("Admin");
    expect(token.silos).toEqual(["BF", "BI"]);
    expect(db.sessions).toEqual([expect.objectContaining({ user_id: ADMIN.id, method: "sso", strong: true })]);
    expect(token.ksid).toBe(db.sessions[0]!.id);
    expect(typeof ex.body.data.refreshToken).toBe("string");
    expect(db.refresh).toEqual([{ user_id: ADMIN.id, ksid: db.sessions[0]!.id }]);
    expect(db.audits.filter((a) => a.action === "sso_sign_in")).toHaveLength(2);
    // The code works once.
    expect((await request(app).post("/api/auth/sso/exchange").send({ code })).status).toBe(401);
  });

  it("refuses a forged or reused state", async () => {
    const { state, cookie } = await startSignIn();
    const forged = await request(app).get(`/api/auth/sso/microsoft/callback?code=abc&state=${encodeURIComponent(state)}x`).set("Cookie", cookie);
    expect(forged.headers.location).toContain("sso_error=state");
    const ok = await request(app).get(`/api/auth/sso/microsoft/callback?code=abc&state=${encodeURIComponent(state)}`).set("Cookie", cookie);
    expect(ok.headers.location).toContain("#sso_code=");
    const again = await request(app).get(`/api/auth/sso/microsoft/callback?code=abc&state=${encodeURIComponent(state)}`).set("Cookie", cookie);
    expect(again.headers.location).toContain("sso_error=state");
  });

  it("refuses an account from another tenant, an unknown email, a lender and a deactivated user (no one is created)", async () => {
    const tryAs = async (setup: () => void) => {
      setup();
      const { state, cookie } = await startSignIn();
      const cb = await request(app).get(`/api/auth/sso/microsoft/callback?code=abc&state=${encodeURIComponent(state)}`).set("Cookie", cookie);
      return new URL(cb.headers.location).searchParams.get("sso_error");
    };
    const other = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
    expect(await tryAs(() => { claims = { tid: other, iss: `https://login.microsoftonline.com/${other}/v2.0` }; })).toBe("wrong_tenant");
    expect(await tryAs(() => { claims = { preferred_username: "nobody@boreal.financial" }; })).toBe("no_user");
    expect(await tryAs(() => { claims = {}; db.users = [{ ...ADMIN, role: "Lender" }]; })).toBe("not_staff");
    expect(await tryAs(() => { db.users = [{ ...ADMIN, active: false }]; })).toBe("user_inactive");
    expect(db.handoffs).toHaveLength(0);
    expect(db.sessions).toHaveLength(0);
    expect(db.audits.filter((a) => a.action === "sso_sign_in_refused").map((a) => a.metadata.reason))
      .toEqual(["wrong_tenant", "no_user", "not_staff", "user_inactive"]);
  });

  it("re-checks the user at the exchange (switched off in the meantime)", async () => {
    const { state, cookie } = await startSignIn();
    const cb = await request(app).get(`/api/auth/sso/microsoft/callback?code=abc&state=${encodeURIComponent(state)}`).set("Cookie", cookie);
    const code = new URLSearchParams(new URL(cb.headers.location).hash.slice(1)).get("sso_code");
    db.users = [{ ...ADMIN, disabled: true }];
    const ex = await request(app).post("/api/auth/sso/exchange").send({ code });
    expect(ex.status).toBe(403);
    expect(db.sessions).toHaveLength(0);
  });
});

describe("id_token checks and matching", () => {
  const cfg = () => providerConfig("microsoft")!;
  const opts = { clientId: CLIENT, nonce: "n1", tenantId: TENANT };
  const resolver = async () => keys.publicKey;

  it("accepts Boreal's tenant and reads the sign-in name when there is no email claim", async () => {
    await expect(verifyIdToken(idToken("n1"), opts, resolver)).resolves.toMatchObject({ email: "ann@boreal.financial", tenantId: TENANT });
    expect(buildAuthorizeUrl(cfg(), { state: "s", nonce: "n", verifier: "v" })).toContain(`/${TENANT}/oauth2/v2.0/authorize`);
  });

  it.each([
    ["bad_nonce", () => idToken("other")],
    ["wrong_audience", () => idToken("n1", { aud: "someone-else" })],
    ["bad_signature", () => idToken("n1", {}, otherKeys.privateKey)],
    ["expired", () => idToken("n1", { exp: Math.floor(Date.now() / 1000) - 3600 })],
    ["wrong_issuer", () => idToken("n1", { iss: "https://evil.example/v2.0" })],
  ])("refuses %s", async (reason, make) => {
    const err = await verifyIdToken(make(), opts, resolver).catch((e) => e);
    expect(err).toBeInstanceOf(SsoError);
    expect(err.reason).toBe(reason);
  });

  it("matches exactly one active staff user and never a lender or referrer with the same email", () => {
    const staff = { id: "a", role: "Staff", active: true, disabled: false, deleted_at: null, status: "active" };
    const lender = { ...staff, id: "b", role: "Lender" };
    expect(pickStaffUser([lender, staff])).toEqual({ user: staff });
    expect(pickStaffUser([staff, { ...staff, id: "c" }])).toEqual({ refusal: "ambiguous_email" });
    expect(pickStaffUser([lender])).toEqual({ refusal: "not_staff" });
    expect(pickStaffUser([])).toEqual({ refusal: "no_user" });
  });
});
