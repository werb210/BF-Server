// BF_SERVER_REQUESTED_DOCS_v351 / BF_SERVER_CALLER_COLUMNS_v351 / BF_SERVER_DASHBOARD_LEGS_v351
import { describe, it, expect } from "vitest";
import fs from "fs";
const read = (p: string) => fs.readFileSync(p, "utf8");
const routes = read("src/modules/applications/applications.routes.ts");
const needed = read("src/routes/clientDocumentsNeeded.ts");
const mig = read("migrations/2026_09_18_v351_application_document_requests.sql");
const dash = read("src/routes/dashboard.ts");
const code = ["src/routes/voiceCalls.ts", "src/routes/webhooks.ts", "src/modules/voice/callerDisplay.ts", "src/services/sequenceEngine.ts", "src/services/rejectionNotice.ts"].map(read).join("\n");
describe("requested documents are stored and required", () => {
 it("has an idempotent table",()=>{expect(mig).toContain("CREATE TABLE IF NOT EXISTS application_document_requests"); expect(mig).toContain("CREATE UNIQUE INDEX IF NOT EXISTS application_document_requests_app_type_uq");});
 it("Request from Client writes each document and lifts a matching waiver",()=>{expect(routes).toContain("INSERT INTO application_document_requests (application_id, document_type, requested_by)"); expect(routes).toContain("ON CONFLICT (application_id, document_type) DO NOTHING"); expect(routes).toContain("DELETE FROM application_document_waivers");});
 it("the required set includes them, so the client's upload task stays open",()=>{expect(needed).toContain("FROM application_document_requests"); expect(needed).toContain("appendRequiredDocAll({ category: row.document_type, required: true }, seen, required)"); expect(needed.indexOf("BF_SERVER_REQUESTED_DOCS_v351")).toBeLessThan(needed.indexOf("BF_SERVER_OPTIONAL_DOCS_v138 - stillNeeded is the BLOCKING"));});
});
describe("caller lookups read columns that exist",()=>{
 it("never selects contacts.full_name or applications.business_name/company_name directly",()=>{expect(code).not.toMatch(/(SELECT|,)\s*c\.full_name\b/); expect(code).not.toMatch(/a\.business_name\b/); expect(code).not.toMatch(/a\.company_name\b/); expect(code).not.toContain("`SELECT business_name FROM applications");});
 it("replaces a placeholder contact name",()=>{expect(code).toContain("c.name ILIKE '%(application started)%'"); expect(read("src/routes/voiceCalls.ts")).toContain("FROM applications ap WHERE ap.id::text = cl.application_id::text");});
});
describe("dashboard commission",()=>{
 it("counts equipment legs and excludes rejected deals from commission",()=>{expect(dash).not.toContain("parent_application_id IS NULL  -- v829"); expect(dash).toContain("NOT IN ('draft', 'Draft', '', 'Rejected')");});
 it("reports native amounts per currency",()=>{expect(dash).toContain("commissionByStageCurrency"); expect(dash).toContain("commissionEarnedByCurrency"); expect(dash).toContain("THEN 'USD'");});
});
