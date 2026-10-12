// BF_SERVER_SIG_POSITION_v1 / BF_SERVER_ADD_REFERRAL_NAMES_v1
import express from "express";
import jwt from "jsonwebtoken";
import request from "supertest";
import { beforeEach, describe, it, expect, vi } from "vitest";
import { pdfContent } from "../../__tests__/helpers/pdfContent.js";

const h = vi.hoisted(() => ({ submit: vi.fn(), queryMock: vi.fn() }));
vi.mock("../../db.js", async () => {
  const actual = await vi.importActual<typeof import("../../db.js")>("../../db.js");
  return { ...actual, pool: { query: h.queryMock } };
});
vi.mock("../../modules/referrals/referrals.service.js", () => ({ submitReferral: h.submit }));

import { buildReferrerAgreementPdf } from "../referrerAgreementPdfBuilder.js";
import referrerSelfRouter from "../../routes/referrerSelf.js";

const REFERRER_ID = "77777777-7777-4777-8777-777777777777";
const app = express();
app.use(express.json());
app.use("/api/referrer", referrerSelfRouter);
const referrer = () => "Bearer " + jwt.sign({ sub: `referrer:${REFERRER_ID}`, role: "Referrer", referrerId: REFERRER_ID }, process.env.JWT_SECRET as string, { algorithm: "HS256" });

beforeEach(() => {
  h.submit.mockReset();
  h.submit.mockResolvedValue({ companyId: "co-1", contactId: "ct-1", refCode: "BF-ABCDEF12" });
  h.queryMock.mockReset();
  h.queryMock.mockResolvedValue({ rows: [{ first_name: "Rae", last_name: "Ferrer" }] });
});

describe("signature position + add-referral names", () => {
  it("agreement still renders", async () => {
    const bytes = await buildReferrerAgreementPdf({ fullName: "Test", email: "t@e.com", phone: "1" });
    expect(bytes.length).toBeGreaterThan(1000);
  });

  it("signature tag lifted above the line", async () => {
    const { runs, lines } = pdfContent(await buildReferrerAgreementPdf({ fullName: "Test", email: "t@e.com", phone: "1" }));
    const tag = runs.find((r) => r.text.startsWith("{{t:s;"));
    expect(tag).toBeDefined();
    // The signature line the tag belongs to sits 22pt below the tag, under it horizontally.
    const line = lines.find((l) => l.y1 === l.y2 && Math.abs(tag!.y - 22 - l.y1) < 0.01 && l.x1 <= tag!.x && tag!.x <= l.x2);
    expect(line).toBeDefined();
    expect(lines.some((l) => l.y1 === tag!.y && l.x1 <= tag!.x && tag!.x <= l.x2)).toBe(false);
  });

  it("add-referral accepts first_name/last_name/business_name", async () => {
    const r = await request(app).post("/api/referrer/add-referral").set("Authorization", referrer())
      .send({ first_name: "Ann", last_name: "Lee", business_name: "Lee Holdings", phone: "+15875550100" });
    expect(r.status).toBe(201);
    expect(h.submit).toHaveBeenCalledTimes(1);
    expect(h.submit.mock.calls[0][0]).toMatchObject({ contactName: "Ann Lee", businessName: "Lee Holdings", phone: "+15875550100", referrerId: REFERRER_ID });
  });

  it("add-referral accepts the camelCase names too, and falls back to the person for the business", async () => {
    const r = await request(app).post("/api/referrer/add-referral").set("Authorization", referrer())
      .send({ firstName: "Bo", lastName: "Chen", phone: "5875550101" });
    expect(r.status).toBe(201);
    expect(h.submit.mock.calls[0][0]).toMatchObject({ contactName: "Bo Chen", businessName: "Bo Chen" });
    const none = await request(app).post("/api/referrer/add-referral").set("Authorization", referrer()).send({ phone: "5875550101" });
    expect(none.status).toBe(400);
    expect(none.body.message).toBe("name_and_phone_required");
  });
});
