// BF_SERVER_v851_APPLICANT_NAME - readiness-prefill never hands the wizard "Unknown (application started)".
import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";
import { answerBySql, type SqlRule } from "./helpers/answerBySql.js";

const query = vi.fn();
vi.mock("../db.js", async (orig) => {
  const real: any = await orig();
  const q = (...a: unknown[]) => query(...a);
  return { ...real, dbQuery: q, pool: { query: q } };
});
import clientRouter from "../routes/client/index.js";

const app = express();
app.use(express.json());
app.use("/api/client", clientRouter);
const PHONE = "+17805550100";
const token = (phone: string) => "Bearer " + jwt.sign({ sub: "client:" + phone, role: "client", phone }, process.env.JWT_SECRET as string);
const APP_SQL = /FROM applications a\s+JOIN contacts c ON c\.id = a\.contact_id/;
const CONTACT_SQL = /SELECT name, first_name, last_name, company_name, email, phone FROM contacts/;
const PLACEHOLDER = "Unknown (application started)";

function answer(rules: SqlRule[]) {
  query.mockImplementation(answerBySql(rules));
}
const ask = () => request(app).get(`/api/client/readiness-prefill?phone=${encodeURIComponent(PHONE)}`).set("Authorization", token(PHONE));

beforeEach(() => { query.mockReset(); answer([]); });

describe("v851 readiness-prefill placeholder names", () => {
  it("CRM fallback: the placeholder contact name and applicant first/last come back as null", async () => {
    answer([[APP_SQL, { rows: [{
      full_name: PLACEHOLDER, first_name: "Unknown", v851_last_name: "(application started)", company_name: "Rivers Co", email: "jordan@rivers.co", phone: PHONE,
      business: null, applicant: { firstName: "Unknown", lastName: "(application started)", fullName: PLACEHOLDER, email: "jordan@rivers.co", city: "Edmonton" },
    }] }]]);
    const r = await ask();
    expect(r.body.found).toBe(true);
    expect(r.body.prefill.fullName).toBeNull();
    expect(r.body.prefill.applicant).toEqual({ email: "jordan@rivers.co", city: "Edmonton" });
    expect(JSON.stringify(r.body)).not.toContain("application started");
    expect(JSON.stringify(r.body)).not.toContain("Unknown");
  });

  it("CRM fallback: a corrected contact name is returned", async () => {
    answer([[APP_SQL, { rows: [{ full_name: "Jordan Rivers", first_name: "Jordan", v851_last_name: "Rivers", applicant: { firstName: "Jordan", lastName: "Rivers" } }] }]]);
    const r = await ask();
    expect(r.body.prefill.fullName).toBe("Jordan Rivers");
    expect(r.body.prefill.applicant).toEqual({ firstName: "Jordan", lastName: "Rivers" });
  });

  it("contact fallback: the placeholder name is null; a placeholder-only contact is not found", async () => {
    answer([[CONTACT_SQL, { rows: [{ name: PLACEHOLDER, first_name: "Unknown", last_name: "(application started)", email: "jordan@rivers.co", phone: PHONE }] }]]);
    const withEmail = await ask();
    expect(withEmail.body).toMatchObject({ found: true, source: "contact", prefill: { fullName: null, email: "jordan@rivers.co" } });

    answer([[CONTACT_SQL, { rows: [{ name: PLACEHOLDER, first_name: "Unknown", last_name: "(application started)", phone: PHONE }] }]]);
    expect((await ask()).body).toEqual({ found: false });
  });

  it("readiness session path: a placeholder full_name is null", async () => {
    answer([[/from readiness_sessions/, { rows: [{ full_name: PLACEHOLDER, email: "jordan@rivers.co" }] }]]);
    const r = await request(app).get("/api/client/readiness-prefill?token=rs-1");
    expect(r.body.prefill.fullName).toBeNull();
    expect(r.body.prefill.email).toBe("jordan@rivers.co");
  });
});
