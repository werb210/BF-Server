// BF_SERVER_TEMPLATE_LANDING_BACKFILL_v28
import { describe, it, expect, vi } from "vitest";
import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";
import { answerBySql } from "./helpers/answerBySql.js";
import { bootIndex } from "./helpers/bootIndex.js";

const query = vi.fn();
vi.mock("../db.js", async (orig) => {
  const real: any = await orig();
  const q = (...a: unknown[]) => query(...a);
  return { ...real, dbQuery: q, runQuery: q, pool: { query: q, connect: vi.fn() } };
});
import marketing from "../routes/marketing.js";
import { isAbsoluteHttpUrl, needsLandingBackfill, type TemplateRow } from "../startup/templateLandingBackfill.js";

const row = (over: Partial<TemplateRow>): TemplateRow => ({
  id: "t1", silo: "BF", name: "Aug 6th - Lenders", subject: "s",
  html: null, link_url: null, fields: { headline: "h", body: "b" }, ...over,
});

describe("isAbsoluteHttpUrl", () => {
  it("rejects the setting-name-as-value case that produced the broken links", () => {
    expect(isAbsoluteHttpUrl("LANDING_BASE_URL/e/ftvf9n1dwg")).toBe(false);
  });
  it("rejects empty and null", () => {
    expect(isAbsoluteHttpUrl("")).toBe(false);
    expect(isAbsoluteHttpUrl(null)).toBe(false);
  });
  it("accepts a real base", () => {
    expect(isAbsoluteHttpUrl("https://www.boreal.financial/e/abc123")).toBe(true);
  });
});

describe("needsLandingBackfill", () => {
  it("flags a seeded row with fields but no html and no url", () => {
    expect(needsLandingBackfill(row({}))).toBe(true);
  });
  it("flags a saved row whose url carries the literal setting name", () => {
    expect(needsLandingBackfill(row({ html: "<p>x</p>", link_url: "LANDING_BASE_URL/e/ftvf9n1dwg" }))).toBe(true);
  });
  it("leaves a healthy row alone", () => {
    expect(needsLandingBackfill(row({ html: "<p>x</p>", link_url: "https://www.boreal.financial/e/abc123" }))).toBe(false);
  });
  it("ignores an empty row with neither fields nor html", () => {
    expect(needsLandingBackfill(row({ fields: null, html: null }))).toBe(false);
  });
});

describe("wiring", () => {
  it("rebuilds landingUrl on the template read path, not just on save", async () => {
    const prev = process.env.LANDING_BASE_URL;
    delete process.env.LANDING_BASE_URL;
    try {
      query.mockImplementation(answerBySql([
        [/FROM marketing_template WHERE/, { rows: [
          { id: "t1", channel: "email", name: "Aug 6th - Lenders", link_url: "LANDING_BASE_URL/e/ftvf9n1dwg" },
          { id: "t2", channel: "sms", name: "Plain", link_url: "https://example.com/offer" },
          { id: "t3", channel: "sms", name: "None", link_url: null },
        ] }],
      ]));
      const app = express();
      app.use("/api/marketing", marketing);
      const token = jwt.sign({ sub: "77777777-7777-4777-8777-777777777777", role: "Admin", tokenVersion: 0, tv: 0 }, process.env.JWT_SECRET as string);
      const r = await request(app).get("/api/marketing/templates").set("Authorization", `Bearer ${token}`);
      expect(r.status).toBe(200);
      const items = (r.body.data ?? r.body).items as Array<{ id: string; landingUrl: string | null }>;
      expect(items.find((i) => i.id === "t1")!.landingUrl).toBe("https://www.boreal.financial/e/ftvf9n1dwg");
      expect(items.find((i) => i.id === "t2")!.landingUrl).toBe("https://example.com/offer");
      expect(items.find((i) => i.id === "t3")!.landingUrl).toBeNull();
    } finally {
      if (prev === undefined) delete process.env.LANDING_BASE_URL; else process.env.LANDING_BASE_URL = prev;
    }
  });

  it("runs the backfill at startup", async () => {
    const boot = await bootIndex();
    try {
      expect(boot.stubs.backfillTemplateLandingPages).toHaveBeenCalledWith(boot.pool);
      expect(boot.logText("log")).toContain('"event":"template_landing_backfill"');
    } finally { boot.restore(); }
  });

  it("a failed backfill cannot kill the process", async () => {
    const boot = await bootIndex({ stubs: { backfillTemplateLandingPages: async () => { throw new Error("relation marketing_template does not exist"); } } });
    try {
      const err = boot.logText("error");
      expect(err).toContain('"event":"template_landing_backfill_error"');
      expect(err).toContain("relation marketing_template does not exist");
      expect(boot.events).toContain("listen");
      expect(boot.exitCodes).toEqual([]);
    } finally { boot.restore(); }
  });
});
