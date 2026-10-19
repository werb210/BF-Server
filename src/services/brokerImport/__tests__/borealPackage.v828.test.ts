// BF_SERVER_v828_BOREAL_PACKAGE_PREFILL / CLIENT_CLAIM_IMPORT
//   - a Boreal application package fills every field from application-fields.json (no OCR / AI)
//   - the client portal lists an accepted broker / lender file and the signed-in client can claim it
import { describe, expect, it, vi } from "vitest";
import { answerBySql, callsMatching } from "../../../__tests__/helpers/answerBySql.js";
import { prefillFromBorealFields, BOREAL_FIELDS_RE } from "../borealPackage.js";
import { claimImportedDraftForPhone, importedDraftsForPhone, preparedBy } from "../claim.js";

const pkg = {
  "Application ID": "11111111-2222-4333-8444-555555555555",
  "Application Name": "Northwind Grocery Ltd",
  "Requested Amount": 250000,
  "kyc.industry": "Retail",
  "kyc.lookingFor": "WORKING_CAPITAL",
  "kyc.fundingAmount": "$250,000",
  "kyc.purposeOfFunds": "Inventory",
  "kyc.businessLocation": "Canada",
  "kyc.annualRevenue": "1,200,000",
  "company.legalName": "Northwind Grocery Ltd",
  "company.businessName": "Northwind Grocery",
  "company.address": "1 Main St",
  "company.city": "Calgary",
  "company.state": "AB",
  "company.zip": "T2P 1A1",
  "company.phone": "(403) 555-0100",
  "company.employees": "12",
  "company.businessStructure": "Corporation",
  "company.startDate": "2019-04-01",
  "borrower.fullName": "Jane Smith",
  "borrower.firstName": "Jane",
  "borrower.lastName": "Smith",
  "borrower.email": "Jane@Example.com",
  "borrower.phone": "(780) 555-0100",
  "borrower.dob": "1980-02-03",
  "borrower.street": "9 Oak Ave",
  "borrower.city": "Edmonton",
  "borrower.state": "AB",
  "borrower.zip": "T5J 0A1",
  "borrower.ownership": "100",
  "formData.applicant.partnerFirstName": "Sam",
  "formData.applicant.partnerLastName": "Lee",
  "formData.attribution.gclid": "ignored",
};

describe("Boreal application package", () => {
  it("is found by its file name, in any folder", () => {
    expect(BOREAL_FIELDS_RE.test("application-fields.json")).toBe(true);
    expect(BOREAL_FIELDS_RE.test("Northwind/application-fields.json")).toBe(true);
    expect(BOREAL_FIELDS_RE.test("application-fields.pdf")).toBe(false);
  });

  it("fills the business, applicant, partner and funding request exactly", () => {
    const p = prefillFromBorealFields(pkg)!;
    expect(p.business).toMatchObject({ legalName: "Northwind Grocery Ltd", businessName: "Northwind Grocery", address: "1 Main St", city: "Calgary",
      state: "AB", zip: "T2P 1A1", phone: "+14035550100", employees: 12, businessStructure: "Corporation", startDate: "2019-04-01" });
    expect(p.applicant).toMatchObject({ firstName: "Jane", lastName: "Smith", email: "jane@example.com", phone: "+17805550100", dob: "1980-02-03",
      street: "9 Oak Ave", city: "Edmonton", state: "AB", zip: "T5J 0A1", ownership: 100 });
    expect(p.partner).toMatchObject({ firstName: "Sam", lastName: "Lee" });
    expect(p.kyc).toMatchObject({ fundingAmount: 250000, purposeOfFunds: "Inventory", lookingFor: "WORKING_CAPITAL", businessLocation: "Canada",
      industry: "Retail", annualRevenue: 1200000, monthlyRevenue: 100000 });
  });

  it("falls back to the formData copy and the full name", () => {
    const p = prefillFromBorealFields({ "formData.business.legalName": "Contoso", "formData.applicant.fullName": "Ada Lovelace King", "Requested Amount": 50000 })!;
    expect(p.business.legalName).toBe("Contoso");
    expect([p.applicant.firstName, p.applicant.lastName]).toEqual(["Ada", "Lovelace King"]);
    expect(p.kyc.fundingAmount).toBe(50000);
    expect(p.partner).toBeNull();
  });

  it("ignores a JSON file that is not a Boreal export", () => {
    expect(prefillFromBorealFields({ hello: "world" })).toBeNull();
    expect(prefillFromBorealFields([1, 2])).toBeNull();
    expect(prefillFromBorealFields(null)).toBeNull();
  });
});

describe("client takes over an imported file", () => {
  it("lists imported drafts for the client's phone as ready to finish", async () => {
    const db = { query: vi.fn(answerBySql([[/FROM applications\s+WHERE source = 'broker_import'/, (_s: string, p?: unknown[]) => ({ rows: p?.[0] === "7805550100" ? [{ id: "app1", ready_to_finish: true }] : [] })]])) };
    expect(await importedDraftsForPhone("7805550100", db)).toEqual([{ id: "app1", ready_to_finish: true }]);
    expect(await importedDraftsForPhone("555", db)).toEqual([]);
  });

  it("claims only a draft waiting for the caller's phone, and never names the lender", async () => {
    const db = { query: vi.fn(answerBySql([
      [/SELECT id::text AS id FROM applications WHERE id::text = \$2/, (_s: string, p?: unknown[]) => ({ rows: p?.[1] === "app1" ? [{ id: "app1" }] : [] })],
      [/RETURNING id::text AS id, metadata/, { rows: [{ id: "app1", metadata: { broker_prefill: { business: { legalName: "Northwind" } }, lender_referral: { lender_name: "Prairie Bank" }, broker_import: { broker_name: "Prairie Bank" } } }] }],
      [/UPDATE broker_imports SET status = 'claimed'/, { rows: [] }],
    ])) };
    expect(await claimImportedDraftForPhone("other", "7805550100", db)).toBeNull();
    const out = await claimImportedDraftForPhone("app1", "7805550100", db);
    expect(out).toEqual({ applicationId: "app1", brokerPrefill: { business: { legalName: "Northwind" } }, brokerName: "the documents you provided" });
    expect(callsMatching(db.query, /broker_claimed_at/)).toHaveLength(1);
    expect(callsMatching(db.query, /pipeline_state = NULL/)).toHaveLength(0); // the column is NOT NULL
    expect(preparedBy({ broker_import: { broker_name: "Avance" } })).toBe("Avance");
  });
});
