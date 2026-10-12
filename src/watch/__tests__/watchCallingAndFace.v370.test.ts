// BF_SERVER_WATCH_CALLBACK_FROM_OTP_v370 / BF_SERVER_WATCH_FACE_v370 / BF_SERVER_WATCH_CALL_ERRORS_v370
import { readFileSync } from "node:fs";
import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { answerBySql, callsMatching } from "../../__tests__/helpers/answerBySql.js";
import { STAFF_USER_ID, mountRouter, staffToken } from "../../__tests__/helpers/staffRouterApp.js";

const h = vi.hoisted(() => ({
  query: vi.fn(),
  client: { query: vi.fn(), release: vi.fn() },
  repo: {
    findLatestOtpSessionByPhone: vi.fn(),
    findLatestOtpVerificationByPhone: vi.fn(),
    findAuthUserByPhone: vi.fn(),
    deleteOtpCodesByPhone: vi.fn(),
    storeRefreshToken: vi.fn(),
    setUserActive: vi.fn(),
  },
}));
vi.mock("../../db.js", async () => ({
  ...(await vi.importActual<any>("../../db.js")),
  pool: { query: h.query, connect: async () => h.client },
  dbQuery: h.query,
}));
vi.mock("../../modules/auth/auth.repo.js", async () => ({
  ...(await vi.importActual<any>("../../modules/auth/auth.repo.js")),
  ...h.repo,
}));
// Verify already approved this code (the recorded verification below), so Twilio is not called.
vi.mock("../../services/twilio.js", async () => ({
  ...(await vi.importActual<any>("../../services/twilio.js")),
  fetchTwilioClient: () => ({}),
  fetchVerifyServiceSid: () => "VA00000000000000000000000000000000",
}));
vi.mock("../../db/ensureOtpTable.js", () => ({ ensureOtpTableExists: async () => undefined }));
vi.mock("../../modules/audit/audit.service.js", async () => ({
  ...(await vi.importActual<any>("../../modules/audit/audit.service.js")),
  recordAuditEvent: async () => undefined,
}));

import { issueWatchAccessToken } from "../security.js";

const migration = readFileSync("migrations/2026_09_21_v370_watch_callback_backfill.sql", "utf-8");
const DEVICE = "d0d0d0d0-0000-4000-8000-000000000370";
const SESSION = "5e550000-0000-4000-8000-000000000370";
const watchToken = () => issueWatchAccessToken(STAFF_USER_ID, DEVICE, SESSION).accessToken;

// The database as the Watch routes see it: an active session, a verified callback number.
const WATCH_DB: Array<[RegExp, unknown]> = [
  [/FROM watch_sessions s JOIN watch_devices d/, { rows: [{ id: SESSION, staff_user_id: STAFF_USER_ID, role: "Staff", silo: "BF", silos: ["BF"] }] }],
  [/SELECT verified_callback_number,callback_verified_at FROM users/, { rows: [{ verified_callback_number: "+14035550170", callback_verified_at: "2026-09-21T00:00:00Z" }] }],
  [/INSERT INTO watch_call_bridges/, { rows: [{ id: "call-1", status: "requesting", version: 1 }] }],
  [/FROM staff_presence/, { rows: [{ status: "available", stale: false }] }],
  [/FROM call_events/, { rows: [{ count: "2" }] }],
  [/FROM tasks/, { rows: [{ count: "3" }] }],
];

beforeEach(() => {
  h.query.mockReset().mockImplementation(answerBySql(WATCH_DB));
  h.client.query.mockReset().mockResolvedValue({ rows: [] });
  h.client.release.mockReset();
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("Watch calls have a callback number", () => {
  it("staff OTP sign-in records the verified phone as the callback number, after marking it verified", async () => {
    const now = new Date();
    const user = { id: STAFF_USER_ID, role: "Staff", active: true, isActive: true, disabled: false, lockedUntil: null, phoneNumber: "+14035550170", tokenVersion: 0, silo: "BF", email: "s@example.com" };
    h.repo.findLatestOtpSessionByPhone.mockResolvedValue({ id: "sess", createdAt: now, expiresAt: new Date(Date.now() + 600_000) });
    h.repo.findLatestOtpVerificationByPhone.mockResolvedValue({ id: "ver", status: "approved", createdAt: now, verifiedAt: now });
    h.repo.findAuthUserByPhone.mockResolvedValue(user);
    const { verifyOtpCode } = await import("../../modules/auth/auth.service.js");
    // Token minting is not what this pins (it needs refresh-token settings); the
    // sign-in reaches the user transaction and commits it either way.
    await verifyOtpCode({ phone: "+1 (416) 509-6632", code: "123456" });
    const statements = h.client.query.mock.calls.map((c) => String(c[0]));
    const verified = statements.findIndex((s) => s.startsWith("update users set phone_verified"));
    const callback = statements.findIndex((s) => /update users set verified_callback_number = \$1, callback_verified_at = now\(\) where id = \$2/.test(s));
    expect(verified).toBeGreaterThan(-1);
    expect(callback).toBeGreaterThan(verified);
    expect(h.client.query.mock.calls[callback][1]).toEqual(["+14165096632", STAFF_USER_ID]);
    expect(statements).toContain("commit");
    expect(statements).not.toContain("rollback");
  });

  it("existing staff are backfilled from their verified login phone, idempotently", () => {
    expect(migration).toContain("SET verified_callback_number = phone_number");
    expect(migration).toContain("WHERE verified_callback_number IS NULL");
    expect(migration).toContain("COALESCE(phone_verified, false) = true");
  });
});

describe("Watch call failures say what went wrong", () => {
  // The suite resets modules after every test, so the provider is set on the
  // same module instance the routes load in this test.
  async function useProvider(createCallback: () => Promise<string>) {
    (await import("../provider.js")).setWatchCallProviderForTests({ createCallback, cancel: async () => undefined });
  }
  async function placeCall() {
    const app = mountRouter((await import("../callRoutes.js")).default, "/api/telephony/watch");
    return request(app).post("/api/telephony/watch/calls").set("Authorization", `Bearer ${watchToken()}`)
      .set("Idempotency-Key", "k-1").send({ destination: "+14035550199", line: "BF" });
  }

  it("a missing caller ID is reported as provider_not_configured", async () => {
    await useProvider(async () => { throw new Error("provider_not_configured"); });
    const res = await placeCall();
    expect(res.status).toBe(503);
    expect(res.body.error).toMatchObject({ code: "provider_not_configured", retryable: false });
    expect(res.body.error.message).toContain("TWILIO_CALLER_ID");
    const [failed] = callsMatching(h.query, /SET status='failed',error_code=\$2/);
    expect(failed[1]).toEqual(["call-1", "provider_not_configured"]);
  });

  it("a provider rejection says so, with the provider's reason", async () => {
    await useProvider(async () => { throw new Error("21215: Geo permission"); });
    const res = await placeCall();
    expect(res.status).toBe(503);
    expect(res.body.error).toMatchObject({ code: "provider_unavailable", retryable: true });
    expect(res.body.error.message).toBe("Calling provider rejected the call: 21215: Geo permission");
    expect(callsMatching(h.query, /SET status='failed',error_code=\$2/)[0][1]).toEqual(["call-1", "provider_unavailable"]);
  });
});

describe("Watch face data", () => {
  const SNAPSHOT = { status: "available", missedCalls: 2, tasksDue: 3 };

  async function watchRoutes() {
    const { API_ROUTE_MOUNTS } = await import("../../routes/routeRegistry.js");
    const mount = API_ROUTE_MOUNTS.find((m) => m.path === "/watch");
    expect(mount).toBeDefined();
    const app = express();
    app.use(express.json());
    app.use("/api/watch", mount!.router);
    return app;
  }

  it("the Watch can fetch its own face data with a Watch token", async () => {
    const app = mountRouter((await import("../dataRoutes.js")).default, "/api/watch");
    const res = await request(app).get("/api/watch/face").set("Authorization", `Bearer ${watchToken()}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject(SNAPSHOT);
    expect(callsMatching(h.query, /FROM staff_presence/)[0][1]).toEqual([STAFF_USER_ID]);
    // A staff token is not a Watch token.
    expect((await request(app).get("/api/watch/face").set("Authorization", `Bearer ${staffToken()}`)).status).toBe(401);
  });

  it("staff /watch/snapshot is no longer shadowed by watchAuth, and /face still answers the Watch", async () => {
    const app = await watchRoutes();
    const staff = await request(app).get("/api/watch/snapshot").set("Authorization", `Bearer ${staffToken()}`);
    expect(staff.status).toBe(200);
    expect(JSON.stringify(staff.body)).toContain('"missedCalls":2');
    const face = await request(app).get("/api/watch/face").set("Authorization", `Bearer ${watchToken()}`);
    expect(face.status).toBe(200);
    expect(face.body).toMatchObject(SNAPSHOT);
  }, 60_000); // the registry imports every router
});
