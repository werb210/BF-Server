// BF_SERVER_v785_OCT11_FOLLOWUP - staff role case, Twilio voice status callbacks,
// credit-readiness score in the response, Maya's reply stored, /api/ai behind staff auth.
import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";
import twilio from "twilio";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { answerBySql, callsMatching } from "./helpers/answerBySql.js";

const { queryMock, TWILIO_TOKEN } = vi.hoisted(() => {
  const TWILIO_TOKEN = "test-auth-token";
  process.env.TWILIO_AUTH_TOKEN = TWILIO_TOKEN;
  return { queryMock: vi.fn(), TWILIO_TOKEN };
});
// The global setup replaces twilio with a stub that has no validateRequest.
vi.mock("twilio", async () => await vi.importActual<any>("twilio"));
vi.mock("../db.js", async () => ({
  ...(await vi.importActual<any>("../db.js")),
  pool: { query: queryMock },
  dbQuery: queryMock,
  runQuery: queryMock,
}));
vi.mock("../modules/ai/ai.service.js", async (orig) => ({
  ...(await orig<any>()),
  generateAIResponse: vi.fn(async () => JSON.stringify({ reply: "Happy to help.", askIntakeQuestions: false })),
}));
vi.mock("../modules/crm/crm.service.js", async (orig) => ({
  ...(await orig<any>()),
  createCrmLead: vi.fn(async () => ({ id: "lead-785" })),
}));
vi.mock("../modules/continuation/continuation.service.js", async (orig) => ({
  ...(await orig<any>()),
  createContinuation: vi.fn(async () => "tok-785"),
}));
vi.mock("../services/contacts.js", async (orig) => ({
  ...(await orig<any>()),
  createContact: vi.fn(async () => ({ id: "contact-785" })),
}));
vi.mock("../services/notifications/notifyAllStaff.js", () => ({
  notifyAllStaff: vi.fn(async () => undefined),
}));

import { isStaffRole } from "../auth/roles.js";
import { auth } from "../middleware/auth.js";

function tok(claims: Record<string, unknown>) {
  return jwt.sign(claims, process.env.JWT_SECRET as string, { algorithm: "HS256" });
}

beforeEach(() => {
  queryMock.mockReset();
  queryMock.mockImplementation(answerBySql([
    [/INSERT INTO readiness_sessions/, { rows: [{ readiness_score: 72, readiness_tier: "green" }], rowCount: 1 }],
  ]));
});

describe("staff role check is case-insensitive", () => {
  it("isStaffRole accepts lowercase admin and staff, still rejects non-staff", () => {
    expect(isStaffRole("admin")).toBe(true);
    expect(isStaffRole("staff")).toBe(true);
    expect(isStaffRole("Admin")).toBe(true);
    expect(isStaffRole("lender")).toBe(false);
    expect(isStaffRole("")).toBe(false);
    expect(isStaffRole(undefined)).toBe(false);
  });

  it("the auth middleware admits lowercase roles and rejects role-less and tracked-link tokens with 401", async () => {
    const app = express();
    app.get("/x", auth, (_req, res) => res.json({ ok: true }));
    for (const role of ["admin", "staff"]) {
      const r = await request(app).get("/x").set("Authorization", `Bearer ${tok({ id: "u-785", role })}`);
      expect(r.status).toBe(200);
    }
    expect((await request(app).get("/x").set("Authorization", `Bearer ${tok({ id: "u-785" })}`)).status).toBe(401);
    expect((await request(app).get("/x").set("Authorization", `Bearer ${tok({ sid: "s1", u: "u1" })}`)).status).toBe(401);
  });
});

describe("POST /api/voice/status accepts Twilio status callbacks", () => {
  const PUBLIC_URL = "https://server.test/api/voice/status";
  const params = { CallSid: "CA785", CallStatus: "completed" };
  async function app() {
    const r = (await import("../routes/voiceCalls.js")).default;
    const a = express();
    a.use(express.json());
    a.use("/api/voice", r);
    return a;
  }

  it("a correctly signed callback gets 200 without a staff token", async () => {
    const res = await request(await app())
      .post("/api/voice/status")
      .set("X-Forwarded-Proto", "https").set("X-Forwarded-Host", "server.test")
      .set("X-Twilio-Signature", twilio.getExpectedTwilioSignature(TWILIO_TOKEN, PUBLIC_URL, params))
      .type("form").send(params);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ callId: "CA785", callStatus: "completed" });
  });

  it("a bad signature gets 403", async () => {
    const res = await request(await app())
      .post("/api/voice/status")
      .set("X-Forwarded-Proto", "https").set("X-Forwarded-Host", "server.test")
      .set("X-Twilio-Signature", twilio.getExpectedTwilioSignature("other-token", PUBLIC_URL, params))
      .type("form").send(params);
    expect(res.status).toBe(403);
  });

  it("without a signature it still needs staff auth", async () => {
    const a = await app();
    expect((await request(a).post("/api/voice/status").send({ callStatus: "completed" })).status).toBe(401);
    const ok = await request(a).post("/api/voice/status")
      .set("Authorization", `Bearer ${tok({ id: "u-785", role: "Staff" })}`)
      .send({ callStatus: "ringing", callSid: "CA1" });
    expect(ok.status).toBe(200);
  });
});

describe("POST /api/website/credit-readiness returns the readiness score", () => {
  it("includes readinessScore and readinessTier from the upsert", async () => {
    const { submitCreditReadiness } = await import("../modules/website/website.controller.js");
    const a = express();
    a.use(express.json());
    a.post("/api/website/credit-readiness", submitCreditReadiness);
    const res = await request(a).post("/api/website/credit-readiness").send({
      companyName: "Acme", fullName: "Pat Doe", phone: "4035551234", email: "pat@example.com",
      requestedAmount: 50000, salesHistoryYears: "3+", annualRevenueRange: "1M-3M",
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true, leadId: "lead-785", readinessScore: 72, readinessTier: "green" });
    expect(res.body.redirect).toContain("tok-785");
    const upsert = callsMatching(queryMock, /INSERT INTO readiness_sessions/);
    expect(String(upsert[0]![0])).toContain("RETURNING readiness_score, readiness_tier");
  });
});

describe("/api/ai router", () => {
  async function app() {
    const r = (await import("../routes/ai.v2.js")).default;
    const a = express();
    a.use(express.json());
    a.use("/api/ai", r);
    return a;
  }

  it("/api/ai/ai/start without a token gets 401", async () => {
    expect((await request(await app()).post("/api/ai/ai/start").send({ source: "website" })).status).toBe(401);
    expect(callsMatching(queryMock, /insert into chat_sessions/)).toHaveLength(0);
  });

  it("/ai/message stores the user's message and Maya's reply", async () => {
    const res = await request(await app())
      .post("/api/ai/ai/message")
      .set("Authorization", `Bearer ${tok({ id: "u-785", role: "Staff" })}`)
      .send({ sessionId: "s-785", message: "Do you do equipment loans?" });
    expect(res.status).toBe(200);
    expect(res.body.reply).toBe("Happy to help.");
    const assistant = callsMatching(queryMock, /insert into chat_messages[\s\S]*'assistant'/);
    expect(assistant).toHaveLength(1);
    expect((assistant[0]![1] as unknown[]).slice(1)).toEqual(["s-785", "Happy to help."]);
    expect(String(assistant[0]![0])).toMatch(/message, content/);
  });
});
