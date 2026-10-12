// BF_SERVER_ADS_CAMPAIGNS_v176
import { readFileSync } from "node:fs";
import { describe, expect, it, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";
import { answerBySql } from "../../__tests__/helpers/answerBySql.js";

const { queryMock, adsSearch, ads } = vi.hoisted(() => ({ queryMock: vi.fn(), adsSearch: vi.fn(), ads: { configured: true } }));
vi.mock("../../db.js", async (orig) => {
  const real: any = await orig();
  const pool = { query: queryMock, connect: vi.fn() };
  return { ...real, pool, db: pool };
});
vi.mock("../../services/googleAdsService.js", async (orig) => {
  const real: any = await orig();
  return { ...real, googleAdsConfigured: () => ads.configured, googleAdsSearch: adsSearch };
});

import marketing from "../marketing.js";

const app = express();
app.use(express.json());
app.use("/api/marketing", marketing);
const token = jwt.sign({ sub: "11111111-1111-4111-8111-111111111111", role: "Admin", tokenVersion: 0, tv: 0 }, process.env.JWT_SECRET!, { expiresIn: "5m" });
const get = (url: string) => request(app).get(url).set("Authorization", `Bearer ${token}`);

beforeEach(() => {
  ads.configured = true;
  queryMock.mockReset();
  queryMock.mockImplementation(answerBySql([]));
  adsSearch.mockReset();
  adsSearch.mockResolvedValue([
    { campaign: { id: "111", name: "BF Search - CA", status: "ENABLED", advertisingChannelType: "SEARCH" } },
    { campaign: { id: "222", name: "BF Search - US", status: "PAUSED", advertisingChannelType: "SEARCH" } },
    { campaign: { name: "no id" } },
  ]);
});

describe("marketing campaigns route", () => {
  it("no longer returns a hardcoded empty campaign list", async () => {
    const r = await get("/api/marketing/campaigns");
    expect(r.status).toBe(200);
    expect(r.body.data).toEqual({
      campaigns: [
        { id: "111", name: "BF Search - CA", status: "ENABLED", channel: "SEARCH" },
        { id: "222", name: "BF Search - US", status: "PAUSED", channel: "SEARCH" },
      ],
      total: 2,
      configured: true,
    });
  });

  it("queries Google Ads for campaign.id so the Negatives panel can bind to it", async () => {
    await get("/api/marketing/campaigns");
    const q = String(adsSearch.mock.calls[0][0]);
    expect(q).toContain("SELECT campaign.id, campaign.name, campaign.status");
    expect(q).toContain("campaign.status != 'REMOVED'");
  });

  it("pages the list", async () => {
    const r = await get("/api/marketing/campaigns?page=2&pageSize=1");
    expect(r.body.data.campaigns.map((c: any) => c.id)).toEqual(["222"]);
    expect(r.body.data.total).toBe(2);
  });

  it("degrades to an empty list rather than throwing when Ads is unconfigured", async () => {
    ads.configured = false;
    const r = await get("/api/marketing/campaigns");
    expect(r.status).toBe(200);
    expect(r.body.data).toEqual({ campaigns: [], total: 0, configured: false });
    expect(adsSearch).not.toHaveBeenCalled();
  });

  it("reports a Google failure instead of throwing", async () => {
    adsSearch.mockRejectedValue(new Error("PERMISSION_DENIED"));
    const r = await get("/api/marketing/campaigns");
    expect(r.status).toBe(200);
    expect(r.body.data).toEqual({ campaigns: [], total: 0, configured: true, error: "PERMISSION_DENIED" });
  });
});

describe("contact name repair migration", () => {
  const sql = readFileSync("migrations/2026_09_15_v176_contact_name_repair.sql", "utf-8");

  it("reads metadata, not the nonexistent form_data column", () => {
    expect(sql).toContain("metadata->'applicant'");
    expect(sql).toContain("metadata->'formData'->'applicant'");
    expect(sql).not.toMatch(/\bform_data\b/);
  });

  it("strips the placeholder fragment out of the derived name", () => {
    expect(sql).toContain("application started");
    expect(sql).toContain("regexp_replace");
  });

  it("is guarded on applications.contact_id existing", () => {
    expect(sql).toContain("column_name = 'contact_id'");
  });
});
