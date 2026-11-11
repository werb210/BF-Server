// OFFER_PRICING_v1 - how we are paid on each offer (Todd, Nov 11 2026): any mix of a rate difference, a broker fee, a set-up
// fee, a fee from the proceeds and the lender's commission; and whose term sheet the client signs.
import express from "express";
import jwt from "jsonwebtoken";
import request from "supertest";
import { beforeEach, describe, it, expect, vi } from "vitest";
import { answerBySql, callsMatching } from "./helpers/answerBySql.js";
import { parseRate, parseTermMonths, revenueFor, clientRateText, monthlyPayment } from "../offers/pricing.js";

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));
vi.mock("../db", async () => {
  const actual = await vi.importActual<typeof import("../db.js")>("../db");
  return { ...actual, pool: { query: queryMock, connect: vi.fn(async () => ({ query: queryMock, release: vi.fn() })) }, runQuery: queryMock, dbQuery: queryMock, query: queryMock };
});
vi.mock("../startupState.js", () => ({ isReady: () => true, fetchStatus: () => ({ reason: null }), markReady: () => undefined, markNotReady: () => undefined, resetStartupState: () => undefined }));

const OFFER = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const STAFF_ID = "00000000-0000-4000-8000-0000000000b1";
const sign = (sub: string, role: string) => jwt.sign({ sub, role, tokenVersion: 0, tv: 0 }, process.env.JWT_SECRET as string);
async function buildApp() {
  const offers = (await import("../routes/offers.js")).default;
  const { errorHandler } = await import("../middleware/errors.js");
  const app = express(); app.use(express.json()); app.use("/api/offers", offers); app.use(errorHandler);
  return app;
}
beforeEach(() => { queryMock.mockReset(); });

describe("pricing maths", () => {
  it("reads rates and terms", () => {
    expect(parseRate("8.5%")).toEqual({ kind: "interest_rate", value: 8.5 });
    expect(parseRate("1.28")).toEqual({ kind: "factor_rate", value: 1.28 });
    expect(parseRate("1.35 factor")).toEqual({ kind: "factor_rate", value: 1.35 });
    expect(parseRate("Prime + 2")).toBeNull();
    expect(parseTermMonths("3 years")).toBe(36);
    expect(parseTermMonths("18 months")).toBe(18);
  });

  it("counts the rate difference over the term: client at 7%, lender at 6%", () => {
    const r = revenueFor({ amount: 100000, lender_rate: "6%", client_rate: 7, term: "36 months" });
    const expected = (monthlyPayment(100000, 7, 36) - monthlyPayment(100000, 6, 36)) * 36;
    expect(r.spread).toBeCloseTo(expected, 0);
    expect(r.spread!).toBeGreaterThan(1500);
    expect(r.total).toBe(r.spread);
    expect(r.client_payment).toBeCloseTo(monthlyPayment(100000, 7, 36), 1);
  });

  it("adds every fee and the lender commission; a fee from proceeds comes off what the client receives", () => {
    const r = revenueFor({ amount: 50000, lender_rate: "1.25", client_rate: 1.3, term: "12", broker_fee: 1000, setup_fee: 495, proceeds_fee: 2000, lender_commission: 1500 });
    expect(r.spread).toBe(2500);
    expect(r.total).toBe(2500 + 1000 + 495 + 2000 + 1500);
    expect(r.funds_to_client).toBe(48000);
    expect(r.client_total_repaid).toBe(65000);
  });

  it("no client rate means no spread; an unreadable lender rate is flagged, not guessed", () => {
    expect(revenueFor({ amount: 10000, lender_rate: "9%", term: "12", setup_fee: 300 }).total).toBe(300);
    const r = revenueFor({ amount: 10000, lender_rate: "Prime + 2", client_rate: 9, term: "12" });
    expect(r.spread).toBeNull();
    expect(r.note).toMatch(/could not be read/);
  });

  it("shows the client our rate in the lender's format", () => {
    expect(clientRateText("6%", 7)).toBe("7%");
    expect(clientRateText("1.25", 1.3)).toBe("1.3 factor");
    expect(clientRateText("6%", null)).toBe("6%");
  });
});

describe("PATCH /api/offers/:id/pricing", () => {
  it("saves any mix and returns the revenue", async () => {
    queryMock.mockImplementation(answerBySql([[/update offers set/i, { rows: [{ id: OFFER, amount: "100000", rate_factor: "6%", term: "36 months", term_sheet_mode: "ours", client_rate: "7", term_months: null, broker_fee: null, setup_fee: "500", proceeds_fee: null, lender_commission: null }] }]]));
    const res = await request(await buildApp()).patch(`/api/offers/${OFFER}/pricing`).set("Authorization", `Bearer ${sign(STAFF_ID, "Staff")}`)
      .send({ term_sheet_mode: "ours", client_rate: "7%", setup_fee: "$500" });
    expect(res.status).toBe(200);
    expect(res.body.offer.revenue.setup_fee).toBe(500);
    expect(res.body.offer.revenue.spread).toBeGreaterThan(1500);
    const [sql, params] = callsMatching(queryMock, /update offers set/i)[0]!;
    expect(String(sql)).toMatch(/term_sheet_mode = \$2, client_rate = \$3, setup_fee = \$4/);
    expect((params as unknown[]).slice(0, 4)).toEqual([OFFER, "ours", 7, 500]);
  });

  it("rejects an unknown term sheet mode and a non-number", async () => {
    const app = await buildApp();
    const auth = `Bearer ${sign(STAFF_ID, "Staff")}`;
    expect((await request(app).patch(`/api/offers/${OFFER}/pricing`).set("Authorization", auth).send({ term_sheet_mode: "bank" })).status).toBe(400);
    expect((await request(app).patch(`/api/offers/${OFFER}/pricing`).set("Authorization", auth).send({ setup_fee: "lots" })).status).toBe(400);
  });
});

describe("our term sheet hides the lender", () => {
  it("will not send the lender's own term sheet when we bought the deal", async () => {
    queryMock.mockImplementation(answerBySql([[/from offers o\s+join applications a/i, { rows: [{ application_id: "A1", blob: "b1", filename: "x.pdf", lender: "Big Bank", mode: "ours", lender_blob: null }] }]]));
    const res = await request(await buildApp()).post(`/api/offers/${OFFER}/send-for-signature`).set("Authorization", `Bearer ${sign(STAFF_ID, "Staff")}`).send({});
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("no_our_term_sheet");
  });
});

describe("template mode (v943)", () => {
  it("accepts the lender's terms on our template, which still needs our term sheet before sending", async () => {
    queryMock.mockImplementation(answerBySql([[/update offers set/i, { rows: [{ id: OFFER, amount: "100000", rate_factor: "6%", term: "36", term_sheet_mode: "template", client_rate: null }] }]]));
    const ok = await request(await buildApp()).patch(`/api/offers/${OFFER}/pricing`).set("Authorization", `Bearer ${sign(STAFF_ID, "Staff")}`).send({ term_sheet_mode: "template" });
    expect(ok.status).toBe(200);
    queryMock.mockImplementation(answerBySql([[/from offers o\s+join applications a/i, { rows: [{ application_id: "A1", blob: "b1", filename: "x.pdf", lender: "Big Bank", mode: "template", lender_blob: null }] }]]));
    const send = await request(await buildApp()).post(`/api/offers/${OFFER}/send-for-signature`).set("Authorization", `Bearer ${sign(STAFF_ID, "Staff")}`).send({});
    expect(send.body.error).toBe("no_our_term_sheet");
  });
});

