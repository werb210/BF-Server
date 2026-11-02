// BF_SERVER_v869_SETTINGS_PACK_SECURITY - signed-in sessions, sign-out per device and everywhere, and the Admin switch that
// requires a passkey or two-step sign-in without locking anyone out. Database fake answers by SQL content.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";
import { answerBySql, callsMatching, type SqlRule } from "../../__tests__/helpers/answerBySql.js";

const h = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("../../db.js", async () => {
  const actual = await vi.importActual<typeof import("../../db.js")>("../../db.js");
  return { ...actual, pool: { query: h.query }, db: { query: h.query }, runQuery: h.query, dbQuery: h.query, query: h.query };
});

import { allowedWithoutStrongSignIn, deviceLabel } from "../sessions.js";

// The suite resets modules after every test (src/tests/setup.ts), so state is set on the instance the routes use.
const sessionsMod = () => import("../sessions.js");
const setRequired = async (on: boolean) => (await sessionsMod()).setSecuritySettingsForTests({ require_strong_sign_in: on });

const ADMIN = "11111111-1111-4111-8111-111111111111";
const STAFF = "22222222-2222-4222-8222-222222222222";
const S_WEAK = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const S_STRONG = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const S_REVOKED = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

const tok = (id: string, ksid?: string) => jwt.sign({ sub: id, id, role: "Staff", tokenVersion: 0, tv: 0, ...(ksid ? { ksid } : {}) }, String(process.env.JWT_SECRET));
let audits: Array<{ type: unknown }>;
const sessions: Record<string, { user_id: string; strong: boolean; revoked_at: string | null }> = {
  [S_WEAK]: { user_id: STAFF, strong: false, revoked_at: null },
  [S_STRONG]: { user_id: ADMIN, strong: true, revoked_at: null },
  [S_REVOKED]: { user_id: STAFF, strong: true, revoked_at: "2026-10-01T00:00:00Z" },
};
function fake(extra: SqlRule[] = []) {
  h.query.mockImplementation(answerBySql([
    ...extra,
    [/FROM users\s+WHERE id = \$1|FROM users WHERE id/, (_s: string, p?: unknown[]) => ({ rows: [{ id: p?.[0], role: p?.[0] === ADMIN ? "Admin" : "Staff", active: true, status: "ACTIVE", token_version: 0, disabled: false }] })],
    [/FROM user_sessions WHERE id::text = \$1/, (_s: string, p?: unknown[]) => {
      const s = sessions[String(p?.[0])];
      return { rows: s ? [{ ...s, last_seen_at: new Date().toISOString() }] : [] };
    }],
    [/FROM user_sessions WHERE user_id::text = \$1 AND revoked_at IS NULL/, (_s: string, p?: unknown[]) => ({ rows: p?.[0] === STAFF ? [
      { id: S_WEAK, user_id: STAFF, method: "otp", strong: false, ip: "203.0.113.5", device_label: "Safari on iPhone", created_at: "2026-10-20T00:00:00Z", last_seen_at: "2026-10-26T00:00:00Z" },
    ] : [] })],
    [/UPDATE user_sessions SET revoked_at = now\(\), revoked_by = \$3::uuid/, (_s: string, p?: unknown[]) => ({ rows: p?.[0] === S_WEAK && (p?.[1] === null || p?.[1] === STAFF) ? [{ id: S_WEAK, device_label: "Safari on iPhone" }] : [] })],
    [/UPDATE user_sessions SET revoked_at = now\(\), revoked_by = \$2::uuid WHERE user_id/, { rows: [{ id: S_WEAK }] }],
    [/insert into audit_events/i, (_s: string, p?: unknown[]) => { audits.push({ type: p?.[4] }); return { rows: [] }; }],
    [/FROM webauthn_credentials WHERE user_id/, { rows: [] }],
  ]));
}
async function app(path = "/api/security", loader: () => Promise<any> = () => import("../../routes/security.js")) {
  const a = express();
  a.use(express.json());
  a.use(path, (await loader()).default);
  return a;
}

beforeEach(async () => {
  h.query.mockReset(); audits = [];
  (await sessionsMod()).clearSessionCache();
  (await import("../../auth/staffUserState.js")).clearStaffUserCache();
  await setRequired(false);
  fake();
});
afterEach(async () => { await setRequired(false); });

describe("sessions", () => {
  it("labels devices in plain words", () => {
    expect(deviceLabel("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1")).toBe("Safari on iPhone");
    expect(deviceLabel("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0 Safari/537.36")).toBe("Chrome on Windows");
    expect(deviceLabel("")).toBe("Unknown device");
  });

  it("refuses a signed-out session, or someone else's, and fails closed when it cannot check", async () => {
    const { checkSession, clearSessionCache } = await sessionsMod();
    expect(await checkSession({ query: h.query } as any, S_WEAK, STAFF)).toEqual({ ok: true, strong: false });
    expect(await checkSession({ query: h.query } as any, S_REVOKED, STAFF)).toMatchObject({ ok: false, status: 401 });
    expect(await checkSession({ query: h.query } as any, S_STRONG, STAFF)).toMatchObject({ ok: false, status: 401 });
    clearSessionCache();
    const warn = vi.spyOn(console, "error").mockImplementation(() => undefined);
    fake([[/FROM user_sessions WHERE id::text = \$1/, new Error("db down")]]);
    expect(await checkSession({ query: h.query } as any, S_WEAK, STAFF)).toMatchObject({ ok: false, status: 503 });
    warn.mockRestore();
  });

  it("a token from a signed-out session is refused by the staff middleware; older tokens without one still work", async () => {
    const a = await app();
    expect((await request(a).get("/api/security/me/sessions").set("Authorization", `Bearer ${tok(STAFF, S_REVOKED)}`)).status).toBe(401);
    expect((await request(a).get("/api/security/me/sessions").set("Authorization", `Bearer ${tok(STAFF)}`)).status).toBe(200);
  });

  it("lists my devices and signs one out; another person's session cannot be signed out from mine", async () => {
    const a = await app();
    const list = await request(a).get("/api/security/me/sessions").set("Authorization", `Bearer ${tok(STAFF, S_WEAK)}`);
    expect(list.body.sessions).toEqual([expect.objectContaining({ id: S_WEAK, device: "Safari on iPhone", method: "otp", current: true })]);
    const out = await request(a).post(`/api/security/me/sessions/${S_WEAK}/sign-out`).set("Authorization", `Bearer ${tok(STAFF, S_WEAK)}`);
    expect(out.status).toBe(200);
    expect(audits.map((x) => x.type)).toContain("session.signed_out");
    const other = await request(a).post(`/api/security/me/sessions/${S_STRONG}/sign-out`).set("Authorization", `Bearer ${tok(STAFF)}`);
    expect(other.status).toBe(404);
  });

  it("sign out everywhere ends every session, older tokens, refresh tokens and dialler Face ID; Admins can do it for anyone", async () => {
    const a = await app();
    const mine = await request(a).post("/api/security/me/sign-out-everywhere").set("Authorization", `Bearer ${tok(STAFF)}`);
    expect(mine.body).toEqual({ ok: true, sessions: 1 });
    expect(callsMatching(h.query, /UPDATE users SET token_version = COALESCE\(token_version, 0\) \+ 1/)[0]![1]).toEqual([STAFF]);
    expect(callsMatching(h.query, /UPDATE auth_refresh_tokens SET revoked_at/)).toHaveLength(1);
    expect(callsMatching(h.query, /UPDATE staff_device_credentials SET revoked_at/)).toHaveLength(1);
    expect((await request(a).post(`/api/security/users/${ADMIN}/sign-out-everywhere`).set("Authorization", `Bearer ${tok(STAFF)}`)).status).toBe(403);
    const admin = await request(a).post(`/api/security/users/${STAFF}/sign-out-everywhere`).set("Authorization", `Bearer ${tok(ADMIN, S_STRONG)}`);
    expect(admin.status).toBe(200);
    expect(audits.map((x) => x.type)).toEqual(expect.arrayContaining(["session.signed_out_everywhere", "session.signed_out_everywhere_by_admin"]));
  });
});

describe("require a passkey or two-step sign-in", () => {
  it("can only be switched on from a session that already meets it, so the Admin cannot lock themselves out", async () => {
    const a = await app();
    const weak = await request(a).put("/api/security/settings").set("Authorization", `Bearer ${tok(ADMIN)}`).send({ require_strong_sign_in: true });
    expect(weak.status).toBe(409);
    expect(weak.body.error).toBe("strong_session_required");
    const strong = await request(a).put("/api/security/settings").set("Authorization", `Bearer ${tok(ADMIN, S_STRONG)}`).send({ require_strong_sign_in: true });
    expect(strong.status).toBe(200);
    expect(callsMatching(h.query, /INSERT INTO boreal_settings/)[0]![1]).toEqual(["security", '{"require_strong_sign_in":true}', ADMIN]);
    expect(audits.map((x) => x.type)).toContain("security.strong_sign_in_required");
  });

  it("while on, a text-code-only session can still sign in, set up a passkey and sign out, but nothing else", async () => {
    await setRequired(true);
    expect(allowedWithoutStrongSignIn("/api/webauthn/register/options")).toBe(true);
    expect(allowedWithoutStrongSignIn("/api/auth/me")).toBe(true);
    expect(allowedWithoutStrongSignIn("/api/security/status")).toBe(true);
    expect(allowedWithoutStrongSignIn("/api/crm/contacts")).toBe(false);
    const a = await app();
    const status = await request(a).get("/api/security/status").set("Authorization", `Bearer ${tok(STAFF, S_WEAK)}`);
    expect(status.body).toEqual({ ok: true, required: true, session_strong: false, has_passkey: false });
    const blocked = await request(a).get("/api/security/me/sessions").set("Authorization", `Bearer ${tok(STAFF, S_WEAK)}`);
    expect(blocked.status).toBe(200); // own security page is allowed
    const crm = await request(a).get(`/api/security/users/${STAFF}/sessions`).set("Authorization", `Bearer ${tok(ADMIN)}`);
    expect(crm.status).toBe(403);
    expect(crm.body.error).toBe("STRONG_SIGN_IN_REQUIRED");
    const ok = await request(a).get(`/api/security/users/${STAFF}/sessions`).set("Authorization", `Bearer ${tok(ADMIN, S_STRONG)}`);
    expect(ok.status).toBe(200);
  });
});
