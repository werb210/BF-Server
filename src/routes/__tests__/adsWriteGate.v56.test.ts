// BF_SERVER_ADS_WRITE_GATE_v56
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";
import { answerBySql } from "../../__tests__/helpers/answerBySql.js";

const { queryMock, uploadFunded } = vi.hoisted(() => ({ queryMock: vi.fn(), uploadFunded: vi.fn() }));
vi.mock("../../db.js", async (orig) => {
  const real: any = await orig();
  const pool = { query: queryMock, connect: vi.fn() };
  return { ...real, pool, db: pool };
});
vi.mock("../../services/googleAdsConversions.js", async (orig) => {
  const real: any = await orig();
  return { ...real, uploadFundedConversions: uploadFunded };
});

import { adsMutateAllowed, ADS_MUTATE_BLOCKED_REASON, applySuggestion, buildSuggestions } from "../../services/googleAdsSuggestions.js";
import marketing from "../marketing.js";

const app = express();
app.use(express.json());
app.use("/api/marketing", marketing);
const token = jwt.sign({ sub: "11111111-1111-4111-8111-111111111111", role: "Admin", tokenVersion: 0, tv: 0 }, process.env.JWT_SECRET!, { expiresIn: "5m" });
const apply = (body: unknown) => request(app).post("/api/marketing/google-ads/suggestions/apply").set("Authorization", `Bearer ${token}`).send(body as object);

const ADS_ENV = ["GOOGLE_ADS_ALLOW_MUTATE", "GOOGLE_ADS_DEVELOPER_TOKEN", "GOOGLE_ADS_CLIENT_ID", "GOOGLE_ADS_CLIENT_SECRET", "GOOGLE_ADS_REFRESH_TOKEN", "GOOGLE_ADS_CUSTOMER_ID"];
const saved = Object.fromEntries(ADS_ENV.map((k) => [k, process.env[k]]));
beforeEach(() => {
  queryMock.mockReset();
  queryMock.mockImplementation(answerBySql([]));
  uploadFunded.mockReset();
  uploadFunded.mockResolvedValue({ configured: true, uploaded: 1, failed: 0, pending: 0 });
});
afterEach(() => {
  vi.unstubAllGlobals();
  for (const k of ADS_ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("campaign changes are off by default", () => {
  it("refuses when the flag is unset", () => {
    delete process.env.GOOGLE_ADS_ALLOW_MUTATE;
    expect(adsMutateAllowed()).toBe(false);
  });

  it("refuses for anything other than an explicit true", () => {
    // Google approved an "internal reporting and Offline conversion" tool that
    // "does not allow users to create or manage campaigns". A typo in the env
    // var must not open the mutate path.
    for (const v of ["", "false", "0", "no", "yes", "1", "TRUE-ish"]) {
      process.env.GOOGLE_ADS_ALLOW_MUTATE = v;
      expect(adsMutateAllowed()).toBe(false);
    }
  });

  it("allows only an explicit true, case and space insensitive", () => {
    for (const v of ["true", "TRUE", " True "]) {
      process.env.GOOGLE_ADS_ALLOW_MUTATE = v;
      expect(adsMutateAllowed()).toBe(true);
    }
  });

  it("blocks applySuggestion before it reaches Google", async () => {
    delete process.env.GOOGLE_ADS_ALLOW_MUTATE;
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const r = await applySuggestion({ type: "pause_campaign", resourceName: "customers/1/campaigns/2" } as any);
    expect(r.ok).toBe(false);
    expect(r.error).toBe(ADS_MUTATE_BLOCKED_REASON);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("explains why in terms someone can act on", () => {
    expect(ADS_MUTATE_BLOCKED_REASON).toContain("internal reporting and offline conversions only");
    expect(ADS_MUTATE_BLOCKED_REASON).toContain("GOOGLE_ADS_ALLOW_MUTATE=true");
  });
});

describe("the route refuses visibly", () => {
  it("returns 403 rather than a 200 carrying ok:false", async () => {
    delete process.env.GOOGLE_ADS_ALLOW_MUTATE;
    const r = await apply({ action: { type: "pause_campaign", resourceName: "customers/1/campaigns/2" } });
    expect(r.status).toBe(403);
    expect(r.body).toEqual({ ok: false, error: "ads_mutate_disabled", message: ADS_MUTATE_BLOCKED_REASON });
  });

  it("checks the gate before reading the action", async () => {
    delete process.env.GOOGLE_ADS_ALLOW_MUTATE;
    // No action at all: still the gate's 403, not the "missing action" answer.
    const blocked = await apply({});
    expect(blocked.status).toBe(403);
    expect(blocked.body.error).toBe("ads_mutate_disabled");
    process.env.GOOGLE_ADS_ALLOW_MUTATE = "true";
    const open = await apply({});
    expect(open.status).toBe(200);
    expect(open.body.data).toEqual({ ok: false, error: "missing action" });
  });
});

describe("read paths are untouched", () => {
  it("does not gate buildSuggestions", async () => {
    delete process.env.GOOGLE_ADS_ALLOW_MUTATE;
    Object.assign(process.env, { GOOGLE_ADS_DEVELOPER_TOKEN: "d", GOOGLE_ADS_CLIENT_ID: "c", GOOGLE_ADS_CLIENT_SECRET: "s", GOOGLE_ADS_REFRESH_TOKEN: "r", GOOGLE_ADS_CUSTOMER_ID: "1234567890" });
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: any) => {
      if (String(url).includes("oauth2.googleapis.com")) return new Response(JSON.stringify({ access_token: "tok", expires_in: 3600 }), { status: 200 });
      const q = String(JSON.parse(String(init.body)).query);
      if (q.includes("FROM campaign ")) {
        return new Response(JSON.stringify({ results: [{ campaign: { resourceName: "customers/1/campaigns/2", name: "Waste" }, metrics: { costMicros: 500_000_000, conversions: 0 } }] }), { status: 200 });
      }
      return new Response(JSON.stringify({ results: [] }), { status: 200 });
    }));
    const out = await buildSuggestions(30);
    expect(out.configured).toBe(true);
    expect(out.suggestions.map((s) => s.kind)).toEqual(["pause_campaign"]);
  });

  it("leaves the conversion upload route alone", async () => {
    delete process.env.GOOGLE_ADS_ALLOW_MUTATE;
    const r = await request(app).post("/api/marketing/google-ads/conversions/upload").set("Authorization", `Bearer ${token}`);
    expect(r.status).toBe(200);
    expect(r.body.data).toEqual({ configured: true, uploaded: 1, failed: 0, pending: 0 });
    expect(uploadFunded).toHaveBeenCalledTimes(1);
  });
});
