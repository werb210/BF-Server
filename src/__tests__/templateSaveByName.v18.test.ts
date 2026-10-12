// BF_SERVER_TEMPLATE_SAVE_BY_NAME_v18
import { describe, expect, it, vi, beforeEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";
import { answerBySql, callsMatching } from "./helpers/answerBySql.js";
import { slugFromLandingUrl } from "../services/landingPage.service.js";

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
const save = (body: Record<string, unknown>, silo = "BF") =>
  request(app).post("/api/marketing/templates").set("Authorization", `Bearer ${token}`).set("X-Silo", silo).send(body);

// A tiny store: one existing template named "Spring" on the BF email channel.
function withExisting() {
  queryMock.mockImplementation(answerBySql([
    [/SELECT id, link_url FROM marketing_template/, (_sql: string, p?: unknown[]) =>
      p?.[0] === "BF" && p?.[1] === "email" && p?.[2] === "Spring"
        ? { rows: [{ id: "tpl-old", link_url: "https://www.boreal.financial/e/oldslug" }], rowCount: 1 }
        : { rows: [], rowCount: 0 }],
    [/INSERT INTO marketing_template/, { rows: [{ id: "tpl-new" }], rowCount: 1 }],
  ]));
}

beforeEach(() => {
  queryMock.mockReset();
  withExisting();
  createFromHtml.mockReset();
  createFromHtml.mockResolvedValue({ slug: "newslug", url: "https://www.boreal.financial/e/newslug" });
  updateHtml.mockReset();
  updateHtml.mockResolvedValue(true);
});

describe("saving a template under an existing name", () => {
  it("looks for a prior template by silo, channel and name", async () => {
    await save({ channel: "email", name: "Spring", html: "<p>x</p>" }, "BI");
    const lookup = callsMatching(queryMock, /SELECT id, link_url FROM marketing_template/)[0];
    expect(lookup[1]).toEqual(["BI", "email", "Spring"]);
  });

  it("updates the prior row instead of inserting a duplicate", async () => {
    const r = await save({ channel: "email", name: "Spring", subject: "S2", html: "<p>v2</p>" });
    expect(r.body.data).toMatchObject({ id: "tpl-old", saved: true, replaced: true });
    expect(callsMatching(queryMock, /INSERT INTO marketing_template/)).toHaveLength(0);
    const upd = callsMatching(queryMock, /UPDATE marketing_template/);
    expect(upd).toHaveLength(1);
    expect((upd[0][1] as unknown[])[0]).toBe("tpl-old");
  });

  it("a new name inserts a new row", async () => {
    const r = await save({ channel: "email", name: "Summer", html: "<p>x</p>" });
    expect(r.body.data).toMatchObject({ id: "tpl-new", replaced: false });
    expect(callsMatching(queryMock, /UPDATE marketing_template/)).toHaveLength(0);
  });

  it("keeps the existing landing page slug so sent links stay live", async () => {
    const r = await save({ channel: "email", name: "Spring", subject: "S2", html: "<p>v2</p>" });
    expect(updateHtml).toHaveBeenCalledWith("oldslug", "<p>v2</p>", "S2");
    expect(createFromHtml).not.toHaveBeenCalled();
    expect(r.body.data.landingUrl).toMatch(/\/e\/oldslug$/);
  });

  it("adds no UNIQUE constraint, which would crash-loop on existing duplicates", () => {
    const dir = path.resolve(__dirname, "../../migrations");
    const sql = fs.readdirSync(dir).filter((f) => f.endsWith(".sql"))
      .map((f) => fs.readFileSync(path.join(dir, f), "utf8")).join("\n");
    expect(sql).not.toMatch(/UNIQUE[^;]*marketing_template[^;]*name/i);
  });
});

describe("slugFromLandingUrl", () => {
  it("pulls the slug out of a landing URL", () => {
    expect(slugFromLandingUrl("https://www.boreal.financial/e/jdwfpnc5zc")).toBe("jdwfpnc5zc");
  });
  it("returns null for anything else", () => {
    expect(slugFromLandingUrl("https://www.boreal.financial/apply")).toBeNull();
    expect(slugFromLandingUrl(null)).toBeNull();
  });
});
