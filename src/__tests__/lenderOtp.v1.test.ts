// BF_SERVER_LENDER_OTP_v1 - /api/auth/otp/verify must have a lender branch:
// userType:"lender" + Twilio-approved code -> match lenders.contact_phone
// (digit-normalized, active BF, most recently updated wins) -> mint a
// Lender-role token carrying lenderId. Without this no lender token can
// ever exist and every /api/lender/* call 403s with lender_role_required.
import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import { answerBySql, callsMatching, sqlText } from "./helpers/answerBySql.js";

const h = vi.hoisted(() => ({ query: vi.fn(), verify: vi.fn() }));
// The production verify path (not the in-memory test-mode branch), with Twilio Verify faked.
vi.mock("../config/runtime.js", async (orig) => ({ ...(await orig<any>()), isTest: false }));
vi.mock("../lib/sharedClients.js", async (orig) => ({
  ...(await orig<any>()),
  sharedTwilio: () => ({ verify: { v2: { services: () => ({ verificationChecks: { create: h.verify } }) } } }),
}));
vi.mock("../lib/db.js", async (orig) => ({ ...(await orig<any>()), runQuery: (sql: unknown, params?: unknown[]) => h.query(sql, params) }));
vi.mock("../services/notifications/notifyAllStaff.js", () => ({ notifyAllStaff: vi.fn(async () => undefined) }));

import authRoutes from "../routes/auth.js";
import { verifyAccessToken } from "../auth/jwt.js";
import { ROLES } from "../auth/roles.js";

const app = express();
app.use(express.json());
app.use("/api/auth", authRoutes);

const PHONE = "+1 (403) 523-0100";
const verify = (body: Record<string, unknown> = {}) =>
  request(app).post("/api/auth/otp/verify").set("X-Forwarded-For", "203.0.113.9").send({ phone: PHONE, code: "123456", userType: "lender", ...body });

beforeEach(() => {
  process.env.TWILIO_VERIFY_SERVICE_SID = "VA_test";
  h.verify.mockReset();
  h.verify.mockResolvedValue({ status: "approved" });
  h.query.mockReset();
  h.query.mockImplementation(answerBySql([[/FROM lenders/, { rows: [{ id: "lender-7", name: "North Bank" }] }]]));
  vi.spyOn(console, "log").mockImplementation(() => undefined);
});

describe("lender OTP branch", () => {
  it("honors userType lender on verify and binds lenderId", async () => {
    const r = await verify();
    expect(r.status).toBe(200);
    expect(r.body.data.user).toEqual({ id: "lender-7", name: "North Bank", phone: "+14035230100", userType: "lender" });
    const claims = verifyAccessToken(r.body.data.token);
    expect(claims).toMatchObject({ sub: "lender:lender-7", role: ROLES.LENDER, lenderId: "lender-7" });
  });

  it("matches lenders.contact_phone digit-normalized, active BF, latest updated wins", async () => {
    await verify();
    const [call] = callsMatching(h.query, /FROM lenders/);
    const sql = sqlText(call![0]);
    expect(sql).toContain("contact_phone");
    // BF_SERVER_LENDER_OTP_PHONE_COLUMNS_v2 - staff form writes primary_contact_phone
    expect(sql).toContain("primary_contact_phone");
    expect(sql).toContain("silo = 'BF'");
    expect(sql).toContain("active = true");
    expect(sql).toMatch(/right\(regexp_replace\(coalesce\(contact_phone, ''\), '\[\^0-9\]', '', 'g'\), 10\)/);
    expect(sql).toMatch(/ORDER BY updated_at DESC\s*$/);
    expect(call![1]).toEqual(["+14035230100"]);
  });

  it("refuses a phone that matches more than one lender", async () => {
    h.query.mockImplementation(answerBySql([[/FROM lenders/, { rows: [{ id: "a", name: "A" }, { id: "b", name: "B" }] }]]));
    const r = await verify();
    expect(r.status).toBe(409);
    expect(r.body.error).toBe("ambiguous_lender_phone");
    expect(r.body.data).toBeUndefined();
  });

  it("refuses with no_lender_for_phone instead of minting a client token", async () => {
    h.query.mockImplementation(answerBySql([[/FROM lenders/, { rows: [] }]]));
    const r = await verify();
    expect(r.status).toBe(403);
    expect(r.body).toEqual({ error: "no_lender_for_phone" });
  });

  it("never reaches the lender lookup without an approved code", async () => {
    h.verify.mockResolvedValue({ status: "pending" });
    const r = await verify();
    expect(r.status).toBe(401);
    expect(callsMatching(h.query, /FROM lenders/)).toHaveLength(0);
  });

  it("AccessTokenPayload carries the lenderId claim", async () => {
    const { signAccessToken } = await import("../auth/jwt.js");
    const token = signAccessToken({ sub: "lender:l1", role: ROLES.LENDER, tokenVersion: 0, lenderId: "l1" });
    expect(verifyAccessToken(token).lenderId).toBe("l1");
  });
});
