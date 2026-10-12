// BF_SERVER_TEMPLATE_FIELDS_ROUNDTRIP_v17
import { describe, expect, it, vi, beforeEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";
import { answerBySql, callsMatching } from "./helpers/answerBySql.js";

const { queryMock, store } = vi.hoisted(() => ({ queryMock: vi.fn(), store: [] as Array<Record<string, unknown>> }));

vi.mock("../db.js", async (orig) => {
  const real: any = await orig();
  const pool = { query: queryMock, connect: vi.fn() };
  return { ...real, pool, db: pool };
});
vi.mock("../services/landingPage.service.js", async (orig) => {
  const real: any = await orig();
  return { ...real, createLandingPageFromHtml: async () => ({ slug: "s1", url: "https://www.boreal.financial/e/s1" }) };
});

import marketing from "../routes/marketing.js";

const app = express();
app.use(express.json());
app.use("/api/marketing", marketing);
const token = jwt.sign({ sub: "11111111-1111-4111-8111-111111111111", role: "Admin", tokenVersion: 0, tv: 0 }, process.env.JWT_SECRET!, { expiresIn: "5m" });

const migration = fs.readFileSync(
  path.resolve(__dirname, "../../migrations/2026_08_05_marketing_template_fields.sql"), "utf8");

beforeEach(() => {
  store.length = 0;
  queryMock.mockReset();
  queryMock.mockImplementation(answerBySql([
    [/INSERT INTO marketing_template \(silo, channel, name, body, link_url, subject, html, fields, created_by\)/, (_s: string, p?: unknown[]) => {
      const [silo, channel, name, body, link_url, subject, html, fields] = p as unknown[];
      store.push({ id: "tpl-" + (store.length + 1), silo, channel, name, body, link_url, subject, html, fields: fields == null ? null : JSON.parse(String(fields)), updated_at: "2026-10-01" });
      return { rows: [{ id: "tpl-" + store.length }], rowCount: 1 };
    }],
    [/FROM marketing_template WHERE/, () => ({ rows: store.map(({ silo: _silo, ...row }) => row) })],
  ]));
});

describe("marketing template library round-trip", () => {
  it("adds the fields column idempotently", () => {
    expect(migration).toContain("ADD COLUMN IF NOT EXISTS fields jsonb");
  });

  it("persists the composer fields on save and returns them on list", async () => {
    const fields = { headline: "Big news", heroUrl: "https://img.test/h.png", headline2: "Right", ctaLabel: "Apply" };
    const saved = await request(app).post("/api/marketing/templates").set("Authorization", `Bearer ${token}`)
      .send({ channel: "email", name: "Spring", subject: "S", html: "<p>x</p>", body: "b", fields });
    expect(saved.body.data.saved).toBe(true);
    const list = await request(app).get("/api/marketing/templates?channel=email").set("Authorization", `Bearer ${token}`);
    expect(list.status).toBe(200);
    expect(list.body.data.items).toHaveLength(1);
    expect(list.body.data.items[0]).toMatchObject({ name: "Spring", subject: "S", html: "<p>x</p>", fields });
  });

  it("serialises fields rather than passing a bare object", async () => {
    await request(app).post("/api/marketing/templates").set("Authorization", `Bearer ${token}`)
      .send({ channel: "sms", name: "Nudge", body: "Hi", fields: { a: 1 } });
    const insert = callsMatching(queryMock, /INSERT INTO marketing_template/)[0];
    const params = insert[1] as unknown[];
    expect(params).toHaveLength(9);
    expect(typeof params[7]).toBe("string");
    expect(JSON.parse(String(params[7]))).toEqual({ a: 1 });
  });

  it("stores null when no fields are sent", async () => {
    await request(app).post("/api/marketing/templates").set("Authorization", `Bearer ${token}`)
      .send({ channel: "sms", name: "Plain", body: "Hi" });
    const insert = callsMatching(queryMock, /INSERT INTO marketing_template/)[0];
    expect((insert[1] as unknown[])[7]).toBeNull();
  });
});
