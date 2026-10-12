// BF_EMAIL_TWO_COLUMN_FIELDS_v1 - templateFieldsFromBody is the only path from the
// composer payload to renderBrandedEmail. Every second-column alias it accepts must
// reach the rendered email, in the preview and in the send.
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";
import { answerBySql } from "./helpers/answerBySql.js";

const { queryMock, sendOne } = vi.hoisted(() => ({ queryMock: vi.fn(), sendOne: vi.fn() }));

vi.mock("../db.js", async (orig) => {
  const real: any = await orig();
  const pool = { query: queryMock, connect: vi.fn() };
  return { ...real, pool, db: pool };
});
vi.mock("../services/sendgridService.js", async (orig) => {
  const real: any = await orig();
  return { ...real, sendgridConfigured: () => true, sendOne };
});

import marketing from "../routes/marketing.js";

const app = express();
app.use(express.json());
app.use("/api/marketing", marketing);
const token = jwt.sign({ sub: "11111111-1111-4111-8111-111111111111", role: "Admin", tokenVersion: 0, tv: 0 }, process.env.JWT_SECRET!, { expiresIn: "5m" });
const preview = async (body: Record<string, unknown>): Promise<string> => {
  const r = await request(app).post("/api/marketing/email/template/preview").set("Authorization", `Bearer ${token}`).send(body);
  expect(r.status).toBe(200);
  return String(r.body.data.html);
};
const base = { headline: "Left headline", body: "Left copy" };

beforeEach(() => {
  queryMock.mockReset();
  queryMock.mockImplementation(answerBySql([]));
  sendOne.mockReset();
  sendOne.mockResolvedValue({ ok: true, status: 202 });
});

describe("BF_EMAIL_TWO_COLUMN_FIELDS_v1", () => {
  it("forwards every supported second-column headline and body alias", async () => {
    for (const [h, b] of [["headline2", "body2"], ["secondHeadline", "secondBody"], ["rightHeadline", "rightBody"], ["column2Headline", "column2Body"]]) {
      const html = await preview({ ...base, [h]: `RightHead-${h}`, [b]: `RightBody-${b}` });
      expect(html).toContain(`RightHead-${h}`);
      expect(html).toContain(`RightBody-${b}`);
      expect(html).toContain('class="email-column"');
    }
  });

  it("prefers the canonical pair when several aliases are sent", async () => {
    const html = await preview({ ...base, headline2: "Canonical", column2Headline: "Alias" });
    expect(html).toContain("Canonical");
    expect(html).not.toContain("Alias");
  });

  it("forwards the right-hand image fields and the portal composer aliases", async () => {
    let html = await preview({ ...base, rightImageUrl: "https://img.test/r.png", rightImageLink: "https://go.test/r" });
    expect(html).toContain('src="https://img.test/r.png"');
    expect(html).toContain('href="https://go.test/r"');
    html = await preview({ ...base, column2ImageUrl: "https://img.test/c2.png", column2ImageLink: "https://go.test/c2" });
    expect(html).toContain('src="https://img.test/c2.png"');
    expect(html).toContain('href="https://go.test/c2"');
  });

  it("a one-column payload renders one column", async () => {
    const html = await preview(base);
    expect(html).toContain("Left headline");
    expect(html).not.toContain('class="email-column"');
  });

  it("the send path renders through the same mapper", async () => {
    const r = await request(app).post("/api/marketing/email/send-template").set("Authorization", `Bearer ${token}`)
      .send({ ...base, subject: "Two columns", test: "me@boreal.test", column2Headline: "SentRight", column2ImageUrl: "https://img.test/s.png" });
    expect(r.status).toBe(200);
    expect(r.body.data.test).toBe(true);
    expect(sendOne).toHaveBeenCalledTimes(1);
    const html = String(sendOne.mock.calls[0][0].html);
    expect(html).toContain("SentRight");
    expect(html).toContain('src="https://img.test/s.png"');
  });
});
