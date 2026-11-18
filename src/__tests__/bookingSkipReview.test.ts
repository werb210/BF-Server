// BF_SERVER_BOOKING_SKIP_REVIEW_v1 - a store reviewer's booking (review@example.com) or the review phone number
// creates nothing and sends nothing, but still answers like a normal booking.
import express from "express";
import request from "supertest";
import { afterAll, beforeEach, describe, it, expect, vi } from "vitest";
import { candidateSlots, isStoreReviewBooking } from "../services/clientBooking.js";

const { queryMock, graphMock } = vi.hoisted(() => ({ queryMock: vi.fn(), graphMock: vi.fn() }));
vi.mock("../db.js", async (orig) => ({ ...(await orig<Record<string, unknown>>()), pool: { query: queryMock } }));
vi.mock("../services/teams/graphAppClient.js", async (orig) => ({ ...(await orig<Record<string, unknown>>()), graphAppFetch: graphMock, isAppGraphConfigured: () => true }));
vi.mock("../modules/automation/automationEngine.js", () => ({ emitAutomationEvent: vi.fn(async () => undefined) }));

beforeEach(() => {
  queryMock.mockReset();
  queryMock.mockImplementation(async () => ({ rows: [], rowCount: 0 }));
  graphMock.mockReset();
  graphMock.mockImplementation(async () => new Response("{}", { status: 200 }));
});

describe("store review bookings", () => {
  it("recognises the review address and the review phone only", () => {
    process.env.REVIEW_LOGIN_PHONE = "+18255550199";
    process.env.REVIEW_LOGIN_CODE = "123456";
    expect(isStoreReviewBooking("Review@Example.com", null)).toBe(true);
    expect(isStoreReviewBooking("someone@else.ca", "+18255550199")).toBe(true);
    expect(isStoreReviewBooking("pat@example.com", "+17805551234")).toBe(false);
    expect(isStoreReviewBooking("jordan@lee.ca", null)).toBe(false);
  });

  afterAll(() => { delete process.env.REVIEW_LOGIN_PHONE; delete process.env.REVIEW_LOGIN_CODE; });

  it("answers 201 with a confirmation but writes nothing and calls Outlook never", async () => {
    const a = express();
    a.use(express.json());
    a.use("/api/public/booking", (await import("../routes/clientBooking.js")).default);
    const startsAt = candidateSlots(new Date(), 14)[2]!.toISOString();
    const res = await request(a).post("/api/public/booking").send({ kind: "phone", startsAt, name: "Alex Morgan", email: "review@example.com", phone: "825-555-0199" });
    expect(res.status).toBe(201);
    expect(res.body.ok).toBe(true);
    expect(res.body.booking.startsAt).toBe(startsAt);
    expect(graphMock).not.toHaveBeenCalled();
    const writes = queryMock.mock.calls.map(([sql]) => String(sql)).filter((s) => /INSERT|UPDATE/i.test(s));
    expect(writes).toEqual([]);
  });
});
