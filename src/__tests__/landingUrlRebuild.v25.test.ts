// BF_SERVER_LANDING_URL_REBUILD_v25
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";
import { answerBySql, callsMatching } from "./helpers/answerBySql.js";
import { landingUrlForSlug, slugFromLandingUrl } from "../services/landingPage.service.js";

const { queryMock, createFromHtml, updateHtml } = vi.hoisted(() => ({
  queryMock: vi.fn(),
  createFromHtml: vi.fn(),
  updateHtml: vi.fn(),
}));

vi.mock("../db.js", async (orig) => {
  const real: any = await orig();
  const pool = { query: queryMock, connect: vi.fn() };
  return { ...real, pool, db: pool };
});
vi.mock("../services/landingPage.service.js", async (orig) => {
  const real: any = await orig();
  return { ...real, createLandingPageFromHtml: createFromHtml, updateLandingPageHtml: updateHtml };
});

import marketing from "../routes/marketing.js";

const app = express();
app.use(express.json());
app.use("/api/marketing", marketing);
const token = jwt.sign({ sub: "11111111-1111-4111-8111-111111111111", role: "Admin", tokenVersion: 0, tv: 0 }, process.env.JWT_SECRET!, { expiresIn: "5m" });

const previousBase = process.env.LANDING_BASE_URL;
beforeEach(() => {
  process.env.LANDING_BASE_URL = "https://landing.example.test/root/";
  queryMock.mockReset();
  queryMock.mockImplementation(answerBySql([
    [/SELECT id, link_url FROM marketing_template/, { rows: [{ id: "tpl-9", link_url: "https://broken.example.test/e/stable_slug" }], rowCount: 1 }],
  ]));
  createFromHtml.mockReset();
  createFromHtml.mockResolvedValue({ slug: "fresh", url: "https://landing.example.test/root/e/fresh" });
  updateHtml.mockReset();
});
afterEach(() => {
  if (previousBase === undefined) delete process.env.LANDING_BASE_URL;
  else process.env.LANDING_BASE_URL = previousBase;
});

describe("landing URL rebuild on re-save", () => {
  it("no longer hands back the stored link_url: the host is rebuilt from the current base, the slug is kept", async () => {
    updateHtml.mockResolvedValue(true);
    const r = await request(app).post("/api/marketing/templates").set("Authorization", `Bearer ${token}`)
      .send({ channel: "email", name: "Spring", subject: "S", html: "<p>v2</p>" });
    expect(r.status).toBe(200);
    expect(r.body.data.landingUrl).toBe("https://landing.example.test/root/e/stable_slug");
    expect(r.body.data.landingUrl).not.toContain("broken.example.test");
    expect(updateHtml).toHaveBeenCalledWith("stable_slug", "<p>v2</p>", "S");
    expect(createFromHtml).not.toHaveBeenCalled();
    const upd = callsMatching(queryMock, /UPDATE marketing_template/)[0];
    expect((upd[1] as unknown[])[2]).toBe("https://landing.example.test/root/e/stable_slug");
  });

  it("mints a new page when the old slug is gone", async () => {
    updateHtml.mockResolvedValue(false);
    const r = await request(app).post("/api/marketing/templates").set("Authorization", `Bearer ${token}`)
      .send({ channel: "email", name: "Spring", html: "<p>v2</p>" });
    expect(r.body.data.landingUrl).toBe("https://landing.example.test/root/e/fresh");
    expect(createFromHtml).toHaveBeenCalledTimes(1);
  });

  it("rebuilds from the current base while preserving the slug", () => {
    const slug = slugFromLandingUrl("https://broken.example.test/e/stable_slug");
    expect(slug).toBe("stable_slug");
    expect(landingUrlForSlug(slug!)).toBe("https://landing.example.test/root/e/stable_slug");
  });
});
