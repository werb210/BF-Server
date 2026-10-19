// BF_SERVER_v828_BOREAL_PACKAGE_PREFILL - the Application tab shows a broker / lender file's fields (read from its
// zip, kept in metadata.broker_prefill) until the client finishes the application; what the client submits wins.
import express from "express";
import jwt from "jsonwebtoken";
import request from "supertest";
import { beforeEach, describe, it, expect, vi } from "vitest";
import { answerBySql } from "../../../__tests__/helpers/answerBySql.js";

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));
vi.mock("../../../db", async () => {
  const actual = await vi.importActual<typeof import("../../../db.js")>("../../../db");
  return { ...actual, pool: { query: queryMock }, runQuery: queryMock, dbQuery: queryMock };
});

const APP_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const token = () => jwt.sign({ sub: "00000000-0000-4000-8000-0000000000b1", role: "Staff", tokenVersion: 0, tv: 0 }, process.env.JWT_SECRET as string);
const prefill = {
  kyc: { fundingAmount: 250000, industry: "Retail" },
  business: { legalName: "Northwind Grocery Ltd", city: "Calgary" },
  applicant: { firstName: "Jane", lastName: "Smith", email: "jane@example.com", phone: "+17805550100" },
};

async function details(metadata: Record<string, unknown>) {
  queryMock.mockImplementation(answerBySql([[/FROM applications a WHERE a\.id::text/, { rows: [{ id: APP_ID, silo: "BF", name: "Northwind", metadata }] }]]));
  const router = (await import("../applications.routes.js")).default;
  const { errorHandler } = await import("../../../middleware/errors.js");
  const app = express();
  app.use(express.json());
  app.use("/api/applications", router);
  app.use(errorHandler);
  return request(app).get(`/api/applications/${APP_ID}/details`).set("Authorization", `Bearer ${token()}`);
}

beforeEach(() => { queryMock.mockReset(); });

describe("Application tab for an imported file", () => {
  it("shows the fields read from the zip", async () => {
    const res = await details({ broker_prefill: prefill });
    expect(res.status).toBe(200);
    expect(res.body.data.businessDetails).toMatchObject({ legalName: "Northwind Grocery Ltd", city: "Calgary" });
    expect(res.body.data.applicantDetails).toMatchObject({ name: "Jane Smith", email: "jane@example.com" });
    expect(res.body.data.financialProfile).toMatchObject({ fundingAmount: 250000, industry: "Retail" });
  });

  it("uses what the client submitted once they finish", async () => {
    const res = await details({ broker_prefill: prefill, business: { legalName: "Northwind Grocery Inc." } });
    expect(res.body.data.businessDetails).toEqual({ legalName: "Northwind Grocery Inc." });
  });
});
