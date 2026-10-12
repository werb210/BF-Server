// BF_SERVER_MAYA_SEES_PORTAL_v782
import { describe, it, expect, vi } from "vitest";
import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";

process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret-min-10-chars";
const OTHER_SHAPE = {
  company: { legalName: "TEST - Todd's Grocery Store", address: "123", city: "any" },
  borrower: { annualRevenue: "1500000", yearsInBusiness: "3" },
  formData: { applicant: { firstName: "Todd", dob: "1970-05-04", street: "12 Elm St", city: "Edmonton", state: "AB", zip: "T6X 1G9", sin: "999" } },
};
const h = vi.hoisted(() => ({ detailsMetadata: null as Record<string, unknown> | null }));
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
    // The staff portal's Application tab (GET /api/applications/:id/details).
    if (sql.includes("FROM applications a WHERE a.id::text = ($1)::text")) {
      return { rows: h.detailsMetadata ? [{ id: "A1", name: "Todd's Grocery", silo: "BF", metadata: h.detailsMetadata, finalized_lenders: 0 }] : [] };
    }
    return { rows: [] };
  };
  return { ...real, pool: { query } };
});
import mayaStaff from "../routes/mayaStaff.js";
import applicationsRoutes from "../modules/applications/applications.routes.js";
import { applicationProfileFromMetadata } from "../services/applications/applicationProfile.js";
import { classifyClaims } from "../auth/principal.js";
import { requireAuth } from "../middleware/auth.js";
import { staffUserLoaderState } from "../auth/staffUserLoaderRegistry.js";

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

  it("uses the same resolution order as the portal's Application tab", async () => {
    const md = { applicant: { a: 1 }, borrower: { b: 2 }, business: { c: 3 }, company: { d: 4 } };
    const p = applicationProfileFromMetadata(md);
    expect(p.applicant).toEqual({ a: 1 });
    expect(p.business).toEqual({ d: 4 });
    expect(p.kyc).toEqual({ b: 2 });

    // The staff portal's Application tab resolves the same slots the same way.
    const portal = express(); portal.use(express.json()); portal.use("/api/applications", applicationsRoutes);
    const staff = "Bearer " + jwt.sign({ sub: "55555555-5555-4555-8555-555555555555", role: "Admin", tokenVersion: 0, tv: 0 }, process.env.JWT_SECRET as string);
    const cases: Array<Record<string, unknown>> = [
      md,
      { kyc_responses: { k: 1 }, kyc: { k: 2 }, business: { c: 3 } },
      { formData: { kyc: { f: 1 }, business: { fb: 1 } } },
      { formData: { financialProfile: { fp: 1 } } },
      { readiness: { r: 1 } },
    ];
    for (const metadata of cases) {
      h.detailsMetadata = metadata;
      const r = await request(portal).get("/api/applications/A1/details").set("Authorization", staff);
      expect(r.status).toBe(200);
      const prof = applicationProfileFromMetadata(metadata);
      const readiness = (metadata.readiness as Record<string, unknown> | undefined) ?? null;
      expect(r.body.data.kyc).toEqual(prof.kyc ?? readiness);
      expect(r.body.data.businessDetails).toEqual(prof.business ?? readiness);
    }
    h.detailsMetadata = null;
  });

  it("the sign-in check no longer looks up service accounts as users", async () => {
    // BF_SERVER_v789_STAFF_USER_STATE - the users lookup runs for staff-human principals
    // only, and agent-service / maya-service classify as service principals.
    expect(classifyClaims({ id: "agent-service", role: "Staff" })).toMatchObject({ kind: "service", serviceName: "agent" });
    expect(classifyClaims({ id: "maya-service", role: "Staff" })).toMatchObject({ kind: "service", serviceName: "maya" });
    expect(classifyClaims({ sub: "66666666-6666-4666-8666-666666666666", role: "Staff" }).kind).toBe("staff");

    const state = staffUserLoaderState();
    const original = state.loader!;
    const lookups: string[] = [];
    state.loader = async (userId, claims, ctx) => { lookups.push(userId); return original(userId, claims, ctx); };
    try {
      const guarded = express();
      guarded.get("/x", requireAuth, (_req, res) => { res.json({ ok: true }); });
      for (const id of ["agent-service", "maya-service"]) {
        const token = jwt.sign({ id, role: "Staff" }, process.env.JWT_SECRET as string);
        const r = await request(guarded).get("/x").set("Authorization", "Bearer " + token);
        expect(r.status).toBe(200);
      }
      expect(lookups).toEqual([]);
      const human = jwt.sign({ sub: "66666666-6666-4666-8666-666666666666", role: "Staff", tokenVersion: 0, tv: 0 }, process.env.JWT_SECRET as string);
      expect((await request(guarded).get("/x").set("Authorization", "Bearer " + human)).status).toBe(200);
      expect(lookups).toEqual(["66666666-6666-4666-8666-666666666666"]);
    } finally {
      state.loader = original;
    }
  });
});
