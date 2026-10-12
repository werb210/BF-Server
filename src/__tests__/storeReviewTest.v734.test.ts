// BF_SERVER_STORE_REVIEW_TEST_v734
import express from "express";
import request from "supertest";
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { answerBySql, callsMatching } from "./helpers/answerBySql.js";

const h = vi.hoisted(() => ({
  query: vi.fn(),
  findAuthUserByPhone: vi.fn(),
  verificationCheck: vi.fn(),
  verificationCreate: vi.fn(),
  quarantine: vi.fn(),
}));
vi.mock("../config/runtime.js", () => ({ isTest: false }));
vi.mock("../middleware/authRateLimit.js", async () => (await import("./helpers/otpVerifyApp.js")).passthroughLimiters());
vi.mock("../lib/sharedClients.js", async () => {
  const { fakeSharedTwilio } = await import("./helpers/otpVerifyApp.js");
  return { sharedTwilio: () => fakeSharedTwilio(h), sharedOpenAI: () => ({}) };
});
vi.mock("../lib/db.js", async () => ({ ...(await vi.importActual<any>("../lib/db.js")), runQuery: h.query }));
vi.mock("../db.js", async () => ({
  ...(await vi.importActual<any>("../db.js")),
  pool: { query: h.query, connect: async () => ({ query: h.query, release: () => undefined }) },
  dbQuery: h.query,
  runQuery: h.query,
}));
vi.mock("../modules/auth/auth.repo.js", async () => ({
  ...(await vi.importActual<any>("../modules/auth/auth.repo.js")),
  findAuthUserByPhone: h.findAuthUserByPhone,
}));
// The real quarantine, observed: every caller goes through this spy.
vi.mock("../services/reviewLogin.js", async () => {
  const actual = await vi.importActual<any>("../services/reviewLogin.js");
  h.quarantine.mockImplementation((q: any) => actual.quarantineReviewRecords(q));
  return { ...actual, quarantineReviewRecords: h.quarantine };
});
// The submit route's ownership guard is not what this file is about.
vi.mock("../auth/clientApplicationOwnership.js", async () => ({
  ...(await vi.importActual<any>("../auth/clientApplicationOwnership.js")),
  applicationParamGuard: async (_req: unknown, _res: unknown, next: () => void) => next(),
}));

import { quarantineReviewRecords } from "../services/reviewLogin.js";

const REVIEW_PHONE = "+18255550199";
const APP_ID = "66666666-6666-4666-8666-666666666666";

beforeEach(() => {
  h.query.mockReset().mockImplementation(answerBySql([]));
  h.quarantine.mockClear();
  h.findAuthUserByPhone.mockReset().mockResolvedValue(null);
  h.verificationCreate.mockReset().mockResolvedValue({ status: "pending" });
});
afterEach(() => {
  delete process.env.REVIEW_LOGIN_PHONE;
  delete process.env.REVIEW_LOGIN_CODE;
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const quarantineCalls = () => callsMatching(h.query, /SET silo = 'TEST'/);

describe("store reviewer test records", () => {
  it("does nothing unless the review login is configured", async () => {
    const q = vi.fn(async () => ({}));
    expect(await quarantineReviewRecords(q)).toBe(false);
    expect(q).not.toHaveBeenCalled();
  });
  it("moves the reviewer's contacts and applications to the TEST silo", async () => {
    process.env.REVIEW_LOGIN_PHONE = REVIEW_PHONE; process.env.REVIEW_LOGIN_CODE = "864213";
    const calls: Array<{ sql: string; params?: unknown[] }> = [];
    const q = vi.fn(async (sql: string, params?: unknown[]) => { calls.push({ sql, params }); return {}; });
    expect(await quarantineReviewRecords(q)).toBe(true);
    expect(calls[0]!.sql).toContain("SET silo = 'TEST'");
    expect(calls[0]!.params).toEqual(["8255550199"]);
    expect(calls[1]!.sql).toContain("jsonb_build_object('store_review', true)");
  });

  it("runs at reviewer sign-in, without sending a text", async () => {
    process.env.REVIEW_LOGIN_PHONE = REVIEW_PHONE; process.env.REVIEW_LOGIN_CODE = "864213";
    vi.stubEnv("TWILIO_VERIFY_SERVICE_SID", "VA00000000000000000000000000000000");
    const { otpApp } = await import("./helpers/otpVerifyApp.js");
    const res = await request(await otpApp()).post("/api/auth/otp/start").send({ phone: REVIEW_PHONE });
    expect(res.status).toBe(200);
    await vi.waitFor(() => expect(quarantineCalls().length).toBeGreaterThan(0));
    expect(quarantineCalls()[0][1]).toEqual(["8255550199"]);
    expect(h.verificationCreate).not.toHaveBeenCalled();
  });

  it("runs 30 s after a submission has finished, never mid-request, on an unref'd timer", async () => {
    process.env.REVIEW_LOGIN_PHONE = REVIEW_PHONE; process.env.REVIEW_LOGIN_CODE = "864213";
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const realSetTimeout = globalThis.setTimeout;
    const delayed: Array<() => void> = [];
    const unref = vi.fn();
    vi.spyOn(globalThis, "setTimeout").mockImplementation(((fn: () => void, ms?: number, ...rest: unknown[]) => {
      if (ms === 30_000) { delayed.push(fn); return { unref } as any; }
      return realSetTimeout(fn, ms, ...rest);
    }) as any);
    // The application exists; everything past the quarantine scheduling fails, so the
    // request ends without the rest of the submit pipeline.
    h.query.mockImplementation(answerBySql([
      [/WHERE id::text = \(\$1\)::text/, { rows: [{ id: APP_ID, silo: "BF", owner_user_id: null }] }],
      [/SET silo = 'TEST'|store_review|UPDATE tasks SET deleted_at/, { rows: [], rowCount: 0 }],
    ], new Error("halt after scheduling")));

    const router = (await import("../routes/client/v1Applications.js")).default;
    const app = express();
    app.use(express.json());
    app.use("/api/client", router);
    await request(app).post(`/api/client/applications/${APP_ID}/submit`).send({ app: { business: { companyName: "Review Co" } } });

    // Nothing moved during the request.
    expect(quarantineCalls()).toHaveLength(0);
    expect(h.quarantine).not.toHaveBeenCalled();
    expect(delayed).toHaveLength(1);
    expect(unref).toHaveBeenCalled();

    delayed[0]();
    await vi.waitFor(() => expect(quarantineCalls().length).toBeGreaterThan(0));
  });

  it("the public start route never quarantines", async () => {
    process.env.REVIEW_LOGIN_PHONE = REVIEW_PHONE; process.env.REVIEW_LOGIN_CODE = "864213";
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    const router = (await import("../routes/publicApplication.js")).default;
    const app = express();
    app.use(express.json());
    app.use("/api/public", router);
    await request(app).post("/api/public/application/start").send({ readiness_phone: REVIEW_PHONE, source: "client" });
    await new Promise((r) => setImmediate(r));
    expect(h.query).toHaveBeenCalled();
    expect(h.quarantine).not.toHaveBeenCalled();
    expect(quarantineCalls()).toHaveLength(0);
  });

  it("removes the reviewer's tasks from the queues", async () => {
    process.env.REVIEW_LOGIN_PHONE = REVIEW_PHONE; process.env.REVIEW_LOGIN_CODE = "864213";
    const sqls: string[] = [];
    await quarantineReviewRecords(async (sql: string) => { sqls.push(sql); return {}; });
    expect(sqls[2]).toContain("UPDATE tasks SET deleted_at = now()");
  });
});
