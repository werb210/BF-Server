// BF_SERVER_EMAIL_TEMPLATE_LANDING_v1 - saving an email template also hosts a
// public landing-page copy and returns its URL; other channels do not.
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";
import { answerBySql, callsMatching } from "./helpers/answerBySql.js";

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
const post = (body: unknown) => request(app).post("/api/marketing/templates").set("Authorization", `Bearer ${token}`).send(body as object);

beforeEach(() => {
  queryMock.mockReset();
  queryMock.mockImplementation(answerBySql([
    [/INSERT INTO marketing_template/, { rows: [{ id: "tpl-1" }], rowCount: 1 }],
  ]));
  createFromHtml.mockReset();
  createFromHtml.mockResolvedValue({ slug: "abc123", url: "https://www.boreal.financial/e/abc123" });
  updateHtml.mockReset();
});

describe("email template landing url", () => {
  it("creates a landing page for an email template and returns landingUrl", async () => {
    const r = await post({ channel: "email", name: "Spring", subject: "Hello", html: "<p>Hi</p>" });
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({ id: "tpl-1", saved: true, landingUrl: "https://www.boreal.financial/e/abc123" });
    expect(createFromHtml).toHaveBeenCalledTimes(1);
    expect(createFromHtml.mock.calls[0][0]).toBe("<p>Hi</p>");
    const insert = callsMatching(queryMock, /INSERT INTO marketing_template/)[0];
    expect((insert[1] as unknown[])[4]).toBe("https://www.boreal.financial/e/abc123");
  });

  it("does not host a landing page for an SMS template", async () => {
    const r = await post({ channel: "sms", name: "Nudge", body: "Hi {{first_name}}", html: "<p>x</p>" });
    expect(r.status).toBe(200);
    expect(r.body.data.saved).toBe(true);
    expect(r.body.data.landingUrl).toBeNull();
    expect(createFromHtml).not.toHaveBeenCalled();
  });

  it("does not host a landing page for an email template with no html", async () => {
    const r = await post({ channel: "email", name: "Empty", subject: "S" });
    expect(r.body.data.landingUrl).toBeNull();
    expect(createFromHtml).not.toHaveBeenCalled();
  });

  it("a landing-page failure still saves the template", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    createFromHtml.mockRejectedValueOnce(new Error("blob down"));
    const r = await post({ channel: "email", name: "Spring", html: "<p>Hi</p>" });
    expect(r.body.data).toMatchObject({ saved: true, landingUrl: null });
    expect(err).toHaveBeenCalledWith("email_template_landing_failed", { error: "blob down" });
    err.mockRestore();
  });
});
