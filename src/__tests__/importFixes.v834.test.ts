// BF_SERVER_v834_IMPORT_FIXES - files sent by a broker or lender:
//   - their documents are OCR'd while the file waits for the client (they sat "OCR queued")
//   - a file imported from a Boreal package before v828 gets its fields from application-fields.json
import { describe, expect, it, vi } from "vitest";
import { answerBySql, callsMatching } from "./helpers/answerBySql.js";
import { backfillPackagePrefill, isPlaceholderName } from "../services/brokerImport/packageBackfill.js";
import { lockOcrJobs } from "../modules/ocr/ocr.repo.js";

const FIELDS = {
  "Application Name": "TEST - Todd's Grocery Store",
  "Requested Amount": 1000000,
  "kyc.industry": "Retail",
  "kyc.purposeOfFunds": "SBA / Start-up",
  "company.legalName": "TEST - Todd's Grocery Store",
  "company.address": "123",
  "company.state": "NE",
  "company.employees": "10",
  "borrower.firstName": "Todd",
  "borrower.lastName": "Werboweski",
  "borrower.email": "todd@example.com",
  "borrower.dob": "1971-10-07",
};

describe("documents of an imported file are OCR'd before the client signs in", () => {
  it("lets draft broker imports through, and only those", async () => {
    const q = { query: vi.fn(async () => ({ rows: [] })) };
    await lockOcrJobs({ limit: 2, lockedBy: "w", client: q as any });
    const sql = String((q.query.mock.calls[0] as unknown[])[0]);
    expect(sql).toContain("a.pipeline_state NOT IN ('draft', 'Draft', '') or a.source = 'broker_import'");
  });
});

describe("package fields for files imported before v828", () => {
  it("knows the names the import made up", () => {
    expect(isPlaceholderName("application 5e601816 d8fc 4161 8a2c f68dab0761ae")).toBe(true);
    expect(isPlaceholderName("Todd's lending company file")).toBe(true);
    expect(isPlaceholderName("TEST - Todd's Grocery Store")).toBe(false);
  });

  it("reads application-fields.json and fills the file once", async () => {
    const db = { query: vi.fn(answerBySql([
      [/FROM applications a\s+JOIN documents d/, { rows: [{ id: "app-1", name: "application 5e601816 d8fc", requested_amount: null, blob_name: "applications/app-1/fields.json" }] }],
      [/UPDATE applications/, { rows: [] }],
    ])) };
    const storage = { get: vi.fn(async () => ({ buffer: Buffer.from(JSON.stringify(FIELDS)) })) };
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    expect(await backfillPackagePrefill({ db, storage })).toBe(1);
    expect(storage.get).toHaveBeenCalledWith("applications/app-1/fields.json");
    const [sql, params] = callsMatching(db.query, /UPDATE applications/)[0]!;
    expect(String(sql)).toContain("package_prefill_backfilled");
    const p = params as unknown[];
    const prefill = JSON.parse(String(p[1]));
    expect(prefill.business.legalName).toBe("TEST - Todd's Grocery Store");
    expect(prefill.business.employees).toBe(10);
    expect(prefill.applicant).toMatchObject({ firstName: "Todd", lastName: "Werboweski", dob: "1971-10-07" });
    expect(prefill.kyc.fundingAmount).toBe(1000000);
    expect(p.slice(2)).toEqual(["TEST - Todd's Grocery Store", true, 1000000]);
    expect(callsMatching(db.query, /UPDATE lender_referrals SET business_name/)[0]![1]).toEqual(["app-1", "TEST - Todd's Grocery Store"]);
    const [findSql] = callsMatching(db.query, /FROM applications a\s+JOIN documents d/)[0]!;
    expect(String(findSql)).toContain("COALESCE(a.metadata->>'package_prefill_backfilled', '') = ''");
  });

  it("an unreadable file is marked as checked, so it is not retried every start", async () => {
    const db = { query: vi.fn(answerBySql([
      [/FROM applications a\s+JOIN documents d/, { rows: [{ id: "app-2", name: "Acme Ltd", blob_name: "x" }] }],
      [/UPDATE applications/, { rows: [] }],
    ])) };
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    expect(await backfillPackagePrefill({ db, storage: { get: async () => null } })).toBe(0);
    const params = callsMatching(db.query, /UPDATE applications/)[0]![1] as unknown[];
    expect(params[1]).toBeNull();
    expect(params[3]).toBe(false); // a real name is kept
  });
});
