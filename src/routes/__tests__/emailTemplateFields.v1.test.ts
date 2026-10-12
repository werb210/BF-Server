// BF_SERVER_EMAIL_TEMPLATE_FULL_FIELDS_v1
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";
import { answerBySql, callsMatching } from "../../__tests__/helpers/answerBySql.js";

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));

vi.mock("../../db.js", async (orig) => {
  const real: any = await orig();
  const pool = { query: queryMock, connect: vi.fn() };
  return { ...real, pool, db: pool };
});

import marketing from "../marketing.js";

const app = express();
app.use(express.json());
app.use("/api/marketing", marketing);
const token = jwt.sign({ sub: "11111111-1111-4111-8111-111111111111", role: "Admin", tokenVersion: 0, tv: 0 }, process.env.JWT_SECRET!, { expiresIn: "5m" });

const previousBase = process.env.LANDING_BASE_URL;
beforeEach(() => {
  process.env.LANDING_BASE_URL = "https://current.example.test";
  queryMock.mockReset();
  queryMock.mockImplementation(answerBySql([
    [/FROM marketing_template WHERE/, {
      rows: [
        { id: "t1", channel: "email", name: "Spring", body: "b", subject: "S", html: "<h1>Hero</h1>", fields: { headline: "Hero" }, link_url: "https://old-host.example.test/e/slug_1", updated_at: "2026-10-01" },
        { id: "t2", channel: "sms", name: "Nudge", body: "Hi", subject: null, html: null, fields: null, link_url: "https://example.test/not-a-landing", updated_at: "2026-09-01" },
        { id: "t3", channel: "sms", name: "Bare", body: "Hi", subject: null, html: null, fields: null, link_url: null, updated_at: "2026-08-01" },
      ],
    }],
  ]));
});
afterEach(() => {
  if (previousBase === undefined) delete process.env.LANDING_BASE_URL;
  else process.env.LANDING_BASE_URL = previousBase;
});

describe("GET /templates returns what the composer needs to restore a template", () => {
  it("selects html and fields alongside body/subject, silo-scoped and channel-filtered", async () => {
    const r = await request(app).get("/api/marketing/templates?channel=email").set("Authorization", `Bearer ${token}`).set("X-Silo", "BI");
    expect(r.status).toBe(200);
    const [sql, params] = callsMatching(queryMock, /FROM marketing_template WHERE/)[0] as [string, unknown[]];
    for (const col of ["id", "channel", "name", "body", "link_url", "subject", "html", "fields", "updated_at"]) expect(sql).toMatch(new RegExp(`\\b${col}\\b`));
    expect(params).toEqual(["BI", "email"]);
    expect(r.body.data.items[0]).toMatchObject({ html: "<h1>Hero</h1>", subject: "S", body: "b", fields: { headline: "Hero" } });
  });

  it("exposes landingUrl rebuilt from the slug against the current host", async () => {
    const r = await request(app).get("/api/marketing/templates").set("Authorization", `Bearer ${token}`);
    const items = r.body.data.items;
    expect(items[0].landingUrl).toBe("https://current.example.test/e/slug_1");
    // A link that is not a landing page is passed through untouched; none stays null.
    expect(items[1].landingUrl).toBe("https://example.test/not-a-landing");
    expect(items[2].landingUrl).toBeNull();
  });
});
