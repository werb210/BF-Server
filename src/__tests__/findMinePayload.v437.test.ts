// BF_SERVER_FIND_MINE_PAYLOAD_v437
// The client lookup (POST /staff/applications-by-phone) answers identity questions: phone and location come
// from the columns contacts actually has, and a contact with no joined application is still found.
import express from "express";
import jwt from "jsonwebtoken";
import request from "supertest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { answerBySql, callsMatching, sqlText } from "./helpers/answerBySql.js";

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));
vi.mock("../db.js", async () => {
  const actual = await vi.importActual<typeof import("../db.js")>("../db.js");
  return { ...actual, pool: { query: queryMock } };
});
vi.mock("../routes/clientDocumentsNeeded.js", () => ({
  computeOutstandingDocs: async () => ({ required: [], stillNeeded: [], rejected: [] }),
}));

import mayaStaff from "../routes/mayaStaff.js";

const root = process.cwd();
const contactsMigration = readFileSync(
  path.join(root, "migrations/20260426_companies_contacts_partners.sql"), "utf8");

const app = express();
app.use(express.json());
app.use("/api/maya", mayaStaff);
const svc = () => "Bearer " + jwt.sign({ kind: "service", source: "agent" }, process.env.JWT_SECRET as string, { algorithm: "HS256" });
const findMine = (phone = "+1 (780) 555-0123") =>
  request(app).post("/api/maya/staff/applications-by-phone").set("Authorization", svc()).send({ phone });

const APP_ROW = {
  id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaa61ae", name: "Todd's Grocery", pipeline_state: "In Review", status: "IN_REVIEW",
  requested_amount: "50000", product_type: "TERM", updated_at: "2026-10-01",
  contact_name: "Todd W", first_name: "Todd", company_name: "Todd Holdings", dob: null, email: "todd@example.test",
  contact_phone: "+17805550123", contact_city: "Edmonton", contact_region: "AB",
};
const CONTACT_ROW = {
  contact_name: "Pat Sibling", first_name: "Pat", company_name: "Sibling Co", dob: null, email: "pat@example.test",
  contact_phone: "780-555-0123", contact_city: "Calgary", contact_region: "AB",
};
const FIND_SQL = /FROM applications a\s+JOIN contacts c ON c.id = a.contact_id/;
const FALLBACK_SQL = /FROM contacts\s+WHERE right\(regexp_replace/;

beforeEach(() => {
  queryMock.mockReset();
  queryMock.mockImplementation(answerBySql([
    [FIND_SQL, { rows: [APP_ROW] }],
    [FALLBACK_SQL, { rows: [CONTACT_ROW] }],
  ]));
});

describe("v437 the client lookup answers identity questions", () => {
  it("uses the location columns contacts actually has", async () => {
    expect(contactsMigration).toContain("ADD COLUMN IF NOT EXISTS address_city");
    expect(contactsMigration).toContain("ADD COLUMN IF NOT EXISTS address_state");
    const r = await findMine();
    expect(r.status).toBe(200);
    const sql = sqlText(callsMatching(queryMock, FIND_SQL)[0][0]);
    expect(sql).toContain("c.address_city");
    expect(sql).toContain("c.address_state");
  });

  it("does not reference columns contacts lacks", async () => {
    await findMine();
    queryMock.mockImplementation(answerBySql([[FIND_SQL, { rows: [] }], [FALLBACK_SQL, { rows: [CONTACT_ROW] }]]));
    await findMine();
    for (const c of [...callsMatching(queryMock, FIND_SQL), ...callsMatching(queryMock, FALLBACK_SQL)]) {
      expect(sqlText(c[0])).not.toContain("c.province");
      expect(sqlText(c[0])).not.toContain("c.city,");
      expect(sqlText(c[0])).not.toMatch(/\bprovince\b(?!')/);
    }
  });

  it("selects the phone Maya was asked for", async () => {
    const r = await findMine();
    expect(sqlText(callsMatching(queryMock, FIND_SQL)[0][0])).toContain("c.phone AS contact_phone");
    expect(r.body.contact.phone).toBe("+17805550123");
  });

  it("carries the location into the contact block", async () => {
    const r = await findMine();
    expect(r.body.contact).toMatchObject({ city: "Edmonton", region: "AB", email: "todd@example.test", contactName: "Todd W" });
  });

  it("falls back to the contact when the application join finds nothing", async () => {
    queryMock.mockImplementation(answerBySql([[FIND_SQL, { rows: [] }], [FALLBACK_SQL, { rows: [CONTACT_ROW] }]]));
    const r = await findMine();
    expect(r.status).toBe(200);
    expect(r.body.applications).toEqual([]);
    expect(r.body.contact).toMatchObject({ contactName: "Pat Sibling", phone: "780-555-0123", city: "Calgary", region: "AB", companyName: "Sibling Co" });
    expect(r.body.contactName).toBe("Pat Sibling");
    const fb = callsMatching(queryMock, FALLBACK_SQL);
    expect(fb).toHaveLength(1);
    expect(sqlText(fb[0][0])).toContain("ORDER BY updated_at DESC NULLS LAST");
  });

  it("does not run the fallback when the application join found the client", async () => {
    await findMine();
    expect(callsMatching(queryMock, FALLBACK_SQL)).toHaveLength(0);
  });

  it("the fallback normalises the phone the same way", async () => {
    queryMock.mockImplementation(answerBySql([[FIND_SQL, { rows: [] }], [FALLBACK_SQL, { rows: [] }]]));
    const r = await findMine("+1 (780) 555-0123");
    expect(r.body.contact).toBeNull();
    const [main] = callsMatching(queryMock, FIND_SQL);
    const [fb] = callsMatching(queryMock, FALLBACK_SQL);
    expect(sqlText(fb[0])).toContain("right(regexp_replace(coalesce(phone, ''), '[^0-9]', '', 'g'), 10) = $1");
    expect(main[1]).toEqual(["7805550123"]);
    expect(fb[1]).toEqual(["7805550123"]);
  });
});
