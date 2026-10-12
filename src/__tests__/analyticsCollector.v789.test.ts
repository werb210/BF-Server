// BF_SERVER_v789_ANALYTICS_COLLECTOR - public /api/analytics: BF-client event shape,
// 60/min per IP, and no email or phone number ever stored.
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";

const h = vi.hoisted(() => ({ inserts: [] as unknown[][], fail: false }));

vi.mock("../db.js", async (orig) => {
  const real: any = await orig();
  const query = async (sql: string, params: unknown[] = []) => {
    if (/insert into analytics_events/i.test(sql)) {
      if (h.fail) throw new Error("db down");
      h.inserts.push(params);
      return { rows: [], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  };
  return { ...real, pool: { query }, runQuery: query, dbQuery: query };
});

import analyticsRoutes, { buildAnalyticsRouter, sanitizeProperties, isContactKey, redactContactText, REDACTED } from "../routes/analytics.js";
import { API_ROUTE_MOUNTS, ROUTES } from "../routes/routeRegistry.js";

function appWith() {
  const app = express();
  app.use("/api/analytics", buildAnalyticsRouter());
  return app;
}
const meta = (i = 0) => JSON.parse(String(h.inserts[i]![1]));

beforeEach(() => { h.inserts.length = 0; h.fail = false; });

describe("v789 /api/analytics accepts the BF-client event shape", () => {
  it("event + properties + session_id, no auth", async () => {
    const r = await request(appWith()).post("/api/analytics").send({ event: "wizard_step_viewed", properties: { step: 3, product: "LOC" }, session_id: "s-123" });
    expect(r.status).toBe(202);
    expect(h.inserts).toHaveLength(1);
    expect(h.inserts[0]![0]).toBe("wizard_step_viewed");
    expect(meta()).toEqual({ source: "bf-client", session_id: "s-123", properties: { step: 3, product: "LOC" } });
  });

  it("name + sessionId aliases", async () => {
    await request(appWith()).post("/api/analytics").send({ name: "otp_sent", sessionId: "abc" });
    expect(h.inserts[0]![0]).toBe("otp_sent");
    expect(meta().session_id).toBe("abc");
    expect(meta().properties).toEqual({});
  });

  it("an event name is required", async () => {
    const r = await request(appWith()).post("/api/analytics").send({ properties: { a: 1 } });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe("event_required");
    expect(h.inserts).toEqual([]);
  });

  it("a failed insert never errors to the page", async () => {
    h.fail = true;
    const r = await request(appWith()).post("/api/analytics").send({ event: "x" });
    expect(r.status).toBe(202);
    expect(r.body.stored).toBe(false);
  });
});

describe("v789 /api/analytics never stores contact details", () => {
  it("drops phone/email keys and redacts phone/email values, including nested ones", async () => {
    await request(appWith()).post("/api/analytics").send({
      event: "lead_form_submitted",
      session_id: "s-1",
      properties: {
        email: "todd@example.com", userEmail: "x@y.co", phone_number: "780-555-0100", mobilePhone: "7805550100", contactPhone: "+1 (780) 555-0100", tel: "7805550100",
        note: "call me at (780) 555-0100 or todd@example.com",
        intl: "+44 20 7946 0958",
        rawNumber: 7805550100,
        amount: 50000,
        ts: 1791761470032,
        nested: { email_address: "a@b.com", label: "write to a@b.com", list: ["780.555.0100", "ok"] },
        application_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      },
    });
    const p = meta().properties;
    for (const k of ["email", "userEmail", "phone_number", "mobilePhone", "contactPhone", "tel"]) expect(p).not.toHaveProperty(k);
    expect(p.note).toBe(`call me at ${REDACTED} or ${REDACTED}`);
    expect(p.intl).toBe(REDACTED);
    expect(p.rawNumber).toBe(REDACTED);
    expect(p.amount).toBe(50000);
    expect(p.ts).toBe(1791761470032);
    expect(p.nested).toEqual({ label: `write to ${REDACTED}`, list: [REDACTED, "ok"] });
    expect(p.application_id).toBe("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
    const stored = JSON.stringify(h.inserts[0]);
    expect(stored).not.toMatch(/example\.com|a@b\.com|555-0100|5550100/);
  });

  it("an event name or session id that is contact data is not stored as-is", async () => {
    await request(appWith()).post("/api/analytics").send({ event: "signup todd@example.com", session_id: "+17805550100" });
    expect(h.inserts[0]![0]).toBe(`signup ${REDACTED}`);
    expect(meta().session_id).toBeNull();
  });

  it("helpers", () => {
    expect(isContactKey("billingEmail")).toBe(true);
    expect(isContactKey("cell")).toBe(true);
    expect(isContactKey("hotel")).toBe(false);
    expect(isContactKey("mailingCity")).toBe(false);
    expect(redactContactText("nothing here 123")).toBe("nothing here 123");
    expect(sanitizeProperties(["not", "an", "object"])).toEqual({});
  });
});

describe("v789 /api/analytics is rate limited and mounted publicly", () => {
  it("allows 60 requests a minute per IP, then 429", async () => {
    const app = appWith();
    for (let i = 0; i < 60; i++) {
      const r = await request(app).post("/api/analytics").send({ event: "e" + i });
      expect(r.status).toBe(202);
    }
    const r = await request(app).post("/api/analytics").send({ event: "one-too-many" });
    expect(r.status).toBe(429);
    expect(h.inserts).toHaveLength(60);
  });

  it("keys the limit on the real client IP, so a forged X-Forwarded-For does not reset it", async () => {
    const app = appWith();
    // Each request claims a different first hop; the address Azure appended is the same.
    for (let i = 0; i < 60; i++) {
      const r = await request(app).post("/api/analytics").set("X-Forwarded-For", `1.2.3.${i}, 77.246.52.163`).send({ event: "e" + i });
      expect(r.status).toBe(202);
    }
    const forged = await request(app).post("/api/analytics").set("X-Forwarded-For", "9.9.9.9, 77.246.52.163").send({ event: "forged" });
    expect(forged.status).toBe(429);
    const other = await request(app).post("/api/analytics").set("X-Forwarded-For", "77.246.52.164").send({ event: "other-client" });
    expect(other.status).toBe(202);
  });

  it("is registered in routeRegistry at /analytics with no auth wrapper", async () => {
    expect(API_ROUTE_MOUNTS).toContainEqual({ path: "/analytics", router: analyticsRoutes });
    expect(ROUTES).toContainEqual({ method: "POST", path: "/api/analytics", roles: [] });
    // The mounted router answers a visitor with no token, and an unverifiable token is not a reason to refuse.
    const app = express();
    app.use("/api/analytics", analyticsRoutes);
    expect((await request(app).post("/api/analytics").set("X-Forwarded-For", "77.246.52.170").send({ event: "visitor" })).status).toBe(202);
    const junk = jwt.sign({ sub: "x" }, "not-the-secret");
    expect((await request(app).post("/api/analytics").set("X-Forwarded-For", "77.246.52.171").set("Authorization", "Bearer " + junk).send({ event: "visitor" })).status).toBe(202);
  });
});
