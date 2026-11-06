// BF_SERVER_v903_YE26_TEMPLATES - the 72 year-end templates and their images.
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import { loadYearEndTemplates, seedYearEndTemplates, YE26_DIR, yearEndFields } from "../startup/seedYearEndTemplates.js";

describe("year-end templates data", () => {
  const all = loadYearEndTemplates();
  it("has 72 templates with unique names, each with its image on disk", () => {
    expect(all).toHaveLength(72);
    expect(new Set(all.map((t) => t.name)).size).toBe(72);
    for (const t of all) {
      expect(fs.existsSync(path.join(YE26_DIR, t.image))).toBe(true);
      expect(t.body).toContain("{{first_name}}");
      expect(t.body).not.toMatch(/\{referral_link\}|\{apply_link\}|\{first_name\}(?!\})/);
    }
  });
  it("client emails carry the button and the tax disclaimer; lender emails are signed by Todd", () => {
    const client = all.find((t) => t.group === "Clients" && t.n === 1)!;
    expect(client.ctaLabel).toBe("Get pre-approved");
    expect(client.ctaUrl).toMatch(/^https:\/\/boreal\.financial\/apply\?/);
    expect(client.body).toContain("confirm with your accountant");
    const lender = all.find((t) => t.group === "CDN Lenders" && t.n === 1)!;
    expect(lender.ctaLabel).toBe("");
    expect(lender.body).toContain("Todd Werboweski");
  });
  it("points the hero at the public image route", () => {
    const f = yearEndFields(all[0]!, "https://server.example.test/");
    expect(f.heroUrl).toBe(`https://server.example.test/api/public/email/ye26/${all[0]!.image}`);
    expect(f.headline).toBe(all[0]!.subject);
  });
});

describe("seedYearEndTemplates", () => {
  it("inserts missing templates into BF and never touches one that exists", async () => {
    const existing = new Set([loadYearEndTemplates()[0]!.name]);
    const query = vi.fn(async (sql: string, params?: unknown[]) => {
      if (/SELECT 1 FROM marketing_template/.test(sql)) return { rows: existing.has(String(params?.[1])) ? [{ "?column?": 1 }] : [] };
      return { rows: [] };
    });
    const out = await seedYearEndTemplates({ query } as any, { publicBase: "https://server.example.test" });
    expect(out).toEqual({ total: 72, inserted: 71, skipped: 1 });
    const inserts = query.mock.calls.filter(([s]) => /INSERT INTO marketing_template/.test(String(s)));
    expect(inserts).toHaveLength(71);
    expect(inserts[0]![1]![0]).toBe("BF");
    expect(String(inserts[0]![1]![4])).toContain("/api/public/email/ye26/");
    expect(query.mock.calls.some(([s]) => /UPDATE marketing_template/.test(String(s)))).toBe(false);
  });
});

describe("public image route", () => {
  it("serves a campaign image and refuses anything else", async () => {
    const { default: publicRoutes } = await import("../routes/public.js");
    const app = express();
    app.use("/api/public", publicRoutes);
    const ok = await request(app).get("/api/public/email/ye26/clients-01.jpg");
    expect(ok.status).toBe(200);
    expect(ok.headers["content-type"]).toBe("image/jpeg");
    expect((await request(app).get("/api/public/email/ye26/templates.json")).status).toBe(404);
    expect((await request(app).get("/api/public/email/ye26/..%2F..%2Fpackage.json")).status).toBe(404);
  });
});
