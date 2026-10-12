// BF_SERVER_FUNDED_CURRENCY_v6
import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, it, expect, vi } from "vitest";
import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";
import { answerBySql, callsMatching } from "./helpers/answerBySql.js";

const h = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("../db.js", async (orig) => ({ ...(await orig() as any), pool: { query: h.query, connect: vi.fn() }, runQuery: h.query, dbQuery: h.query }));
vi.mock("../services/biCarrierSubmit.js", () => ({ submitBiToCarrier: async () => ({ ok: true, skipped: "no_pgi" }) }));
import offerAcceptance from "../routes/offerAcceptance.js";
import dashboard from "../routes/dashboard.js";

const migration = readFileSync(
  path.join(process.cwd(), "migrations/2026_08_03_funded_currency.sql"),
  "utf8",
);

const staff = "Bearer " + jwt.sign({ sub: "76767676-7676-4676-8676-767676767676", role: "Admin", tokenVersion: 0, tv: 0 }, process.env.JWT_SECRET as string);
const app = express();
app.use(express.json());
app.use("/api/offers", offerAcceptance);
app.use("/api/dashboard", dashboard);
const confirm = (body: Record<string, unknown>) => request(app).post("/api/offers/off-1/confirm-acceptance").set("Authorization", staff).send(body);
const FUNDED_WRITE = /SET funded_currency = \$4/;

beforeEach(() => {
  h.query.mockReset();
  h.query.mockImplementation(answerBySql([
    [/UPDATE offers\s+SET status = 'accepted'/, { rows: [{ id: "off-1", application_id: "app-1", status: "accepted" }] }],
  ]));
});

describe("funded currency v6", () => {
  it("requires the funded amount on acceptance", async () => {
    for (const fundedAmount of [undefined, null, "", "  "]) {
      const r = await confirm({ fundedAmount, fundedCurrency: "CAD" });
      expect(r.status).toBe(400);
      expect(r.body).toEqual({ error: "funded_amount_required" });
    }
    expect(callsMatching(h.query, FUNDED_WRITE)).toHaveLength(0);
    // BF_SERVER_v789 - the offer is not marked accepted when the request is refused.
    expect(callsMatching(h.query, /SET status = 'accepted'/)).toHaveLength(0);
  });

  it("only accepts CAD or USD", async () => {
    const eur = await confirm({ fundedAmount: 1000, fundedCurrency: "EUR" });
    expect(eur.status).toBe(400);
    expect(eur.body).toEqual({ error: "invalid_funded_currency" });
    expect(callsMatching(h.query, FUNDED_WRITE)).toHaveLength(0);
    // BF_SERVER_v789 - the offer is not marked accepted when the request is refused.
    expect(callsMatching(h.query, /SET status = 'accepted'/)).toHaveLength(0);

    const usd = await confirm({ fundedAmount: 1000, fundedCurrency: "usd" });
    expect(usd.status).toBe(200);
    expect(callsMatching(h.query, FUNDED_WRITE)[0][1]).toEqual(["app-1", 1000, "off-1", "USD"]);
    h.query.mockClear();
    await confirm({ funded_amount: "2500" }); // currency defaults to CAD
    expect(callsMatching(h.query, FUNDED_WRITE)[0][1]).toEqual(["app-1", 2500, "off-1", "CAD"]);
  });

  it("defaults existing rows to CAD", () => {
    expect(migration).toContain("funded_currency TEXT NOT NULL DEFAULT 'CAD'");
  });

  it("converts to CAD before summing, so a USD deal is not counted as CAD", async () => {
    await request(app).get("/api/dashboard/metrics").set("Authorization", staff);
    await request(app).get("/api/dashboard/analytics").set("Authorization", staff);
    const converting = h.query.mock.calls
      .map((c) => String(c[0]))
      .filter((sql) => /SUM\(x\.native \* COALESCE\(\(SELECT to_cad FROM fx_rates WHERE currency = x\.currency\), 1\)\)/.test(sql));
    expect(converting.length).toBeGreaterThanOrEqual(2);
  });
});
