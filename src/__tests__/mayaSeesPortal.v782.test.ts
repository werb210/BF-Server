// BF_SERVER_MAYA_SEES_PORTAL_v782
import { describe, it, expect, vi } from "vitest";
import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";
import { readFileSync } from "node:fs";

process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret-min-10-chars";
const OTHER_SHAPE = {
  company: { legalName: "TEST - Todd's Grocery Store", address: "123", city: "any" },
  borrower: { annualRevenue: "1500000", yearsInBusiness: "3" },
  formData: { applicant: { firstName: "Todd", dob: "1970-05-04", street: "12 Elm St", city: "Edmonton", state: "AB", zip: "T6X 1G9", sin: "999" } },
};
vi.mock("../db.js", async (orig) => {
  const real: any = await orig();
  const query = async (sql: string) => {
    if (sql.includes("FROM applications a") && sql.includes("JOIN contacts c")) return { rows: [{
      id: "A1", name: "TEST - Todd's Grocery Store", pipeline_state: "In Review", requested_amount: 1000000, product_type: "SBA", updated_at: "2026-10-08",
      contact_name: "Todd Werboweski", first_name: "Todd", company_name: null, dob: null, email: "t@x.com", contact_phone: "+17805550100",
      created_at: "2026-10-07T15:00:00Z", submitted_at: "2026-10-07T16:00:00Z", business_md: null, applicant_md: null,
      metadata_full: OTHER_SHAPE, signnow_app_signed_at: null, funded_at: null,
    }] };
    if (sql.includes("FROM offers")) return { rows: [{ lender_name: "Bank A", amount: "750000", term: "10y", rate_factor: "Prime+2.75", status: "pending", expiry_date: "2026-11-01" }] };
    return { rows: [] };
  };
  return { ...real, pool: { query } };
});
import mayaStaff from "../routes/mayaStaff.js";
import { applicationProfileFromMetadata } from "../services/applications/applicationProfile.js";

const app = express(); app.use(express.json()); app.use("/api/maya", mayaStaff);
const svc = "Bearer " + jwt.sign({ kind: "service", source: "agent" }, process.env.JWT_SECRET as string);

describe("client Maya sees what the staff portal shows", () => {
  it("finds business, applicant and revenue wherever the wizard saved them, plus offers", async () => {
    const r = await request(app).post("/api/maya/staff/applications-by-phone").set("Authorization", svc).send({ phone: "+17805550100" });
    const a = r.body.applications[0];
    expect(a.business).toEqual({ legalName: "TEST - Todd's Grocery Store", address: "123", city: "any" });
    expect(a.owner).toMatchObject({ dob: "1970-05-04", street: "12 Elm St", zip: "T6X 1G9" });
    expect(a.owner.sin).toBeUndefined();
    expect(a.financialProfile).toMatchObject({ annualRevenue: "1500000", yearsInBusiness: "3" });
    expect(r.body.contact.dob).toBe("1970-05-04");
    expect(r.body.contact.homeAddress).toBe("12 Elm St, Edmonton, AB, T6X 1G9");
    expect(r.body.offers).toEqual([{ lender: "Bank A", amount: 750000, term: "10y", rate: "Prime+2.75", status: "pending", expires: "2026-11-01" }]);
  });
  it("uses the same resolution order as the portal's Application tab", () => {
    const p = applicationProfileFromMetadata({ applicant: { a: 1 }, borrower: { b: 2 }, business: { c: 3 }, company: { d: 4 } });
    expect(p.applicant).toEqual({ a: 1 });
    expect(p.business).toEqual({ d: 4 });
    expect(p.kyc).toEqual({ b: 2 });
    const routes = readFileSync("src/modules/applications/applications.routes.ts", "utf8");
    expect(routes).toContain("kyc: md?.borrower ?? md?.kyc_responses ?? md?.kyc ?? fd?.kyc ?? fd?.financialProfile ?? readinessSrc ?? null,");
    expect(routes).toContain("businessDetails: md?.company ?? md?.business ?? fd?.business ?? readinessSrc ?? null,");
  });
  it("the sign-in check no longer looks up service accounts as users", () => {
    expect(readFileSync("src/middleware/auth.ts", "utf8")).toContain('!["agent-service", "maya-service"].includes(userId)');
  });
});
