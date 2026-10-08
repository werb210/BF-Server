// BF_SERVER_MAYA_KNOWS_CLIENT_v779
import { describe, it, expect, vi } from "vitest";
import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";

process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret-min-10-chars";
vi.mock("../db.js", async (orig) => {
  const real: any = await orig();
  const query = async (sql: string) => {
    if (sql.includes("FROM applications a") && sql.includes("JOIN contacts c")) return { rows: [{
      id: "A1", name: "Boreal Financial", pipeline_state: "Documents Required", status: null, requested_amount: 250000, product_type: "TERM",
      updated_at: "2026-10-07T00:00:00Z", contact_name: "Todd Werboweski", first_name: "Todd", company_name: "Boreal", dob: null, email: "todd@x.com",
      contact_phone: "+17805550100", contact_city: "Edmonton", contact_region: "AB", industry: "Finance", years_in_business: "5", annual_revenue: "1M",
      created_at: "2026-09-12T15:00:00Z", submitted_at: "2026-09-13T16:00:00Z",
      business_md: { legalName: "2630108 Alberta Ltd.", businessStructure: "Corporation", address: "450 Sparling Crt SW", website: "https://boreal.financial", businessNumber: "762010221" },
      applicant_md: { firstName: "Todd", dob: "1970-05-04", street: "12 Elm St", city: "Edmonton", state: "AB", zip: "T6X 1G9", title: "Owner/Operator", ownership: "100", ssn: "123-456-789" },
    }] };
    return { rows: [] };
  };
  return { ...real, pool: { query } };
});
import mayaStaff, { mayaSafeFields } from "../routes/mayaStaff.js";

const app = express();
app.use(express.json());
app.use("/api/maya", mayaStaff);
const svc = "Bearer " + jwt.sign({ kind: "service", source: "agent" }, process.env.JWT_SECRET as string);

describe("Maya knows what we know about the signed-in client", () => {
  it("returns application dates, home address, date of birth, title, ownership and business details", async () => {
    const r = await request(app).post("/api/maya/staff/applications-by-phone").set("Authorization", svc).send({ phone: "+17805550100" });
    expect(r.status).toBe(200);
    const a = r.body.applications[0];
    expect(a.startedAt).toBe("2026-09-12T15:00:00Z");
    expect(a.submittedAt).toBe("2026-09-13T16:00:00Z");
    expect(a.business).toEqual({ legalName: "2630108 Alberta Ltd.", businessStructure: "Corporation", address: "450 Sparling Crt SW", website: "https://boreal.financial" });
    expect(a.owner).toMatchObject({ dob: "1970-05-04", title: "Owner/Operator", ownership: "100" });
    expect(a.owner.ssn).toBeUndefined();
    expect(r.body.contact.dob).toBe("1970-05-04");
    expect(r.body.contact.homeAddress).toBe("12 Elm St, Edmonton, AB, T6X 1G9");
  });
  it("never passes ID numbers or banking to Maya", () => {
    expect(mayaSafeFields({ businessName: "A", sin: "1", partnerSsn: "2", bankAccount: "3", accountNumber: "4", dob: "x" })).toEqual({ businessName: "A", dob: "x" });
  });
});
