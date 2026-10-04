import { describe, it, expect, vi } from "vitest";
// BF_SERVER_ORCHESTRATOR_DOCS_GATE_v742 - documents come from the live outstanding list, not document_requirements.
const outstanding = vi.hoisted(() => ({ value: { stillNeeded: [] as unknown[], rejected: [] as unknown[], required: [] as unknown[] } }));
vi.mock("../../../src/routes/clientDocumentsNeeded.js", () => ({ computeOutstandingDocs: async () => outstanding.value }));
import { readReadinessSnapshot, maybeStartCreditSummaryAndSign, maybeBuildAndSendPackage, progressSubmission } from "../../../src/services/submission/orchestrator";
function fakePool(rowsByQuery: Record<string, unknown[]>): any {
  return { query: vi.fn(async (sql: string) => { for (const key of Object.keys(rowsByQuery)) if (sql.includes(key)) return { rows: rowsByQuery[key] }; return { rows: [] }; }) };
}
describe("orchestrator readiness", () => {
  it("returns blocked when a required category has no accepted doc", async () => {
    outstanding.value = { stillNeeded: [{ document_type: "bank_statements" }], rejected: [], required: [] };
    const pool = fakePool({ "application_tasks": [{ open_count: "0" }], "application_lender_selections": [{ finalized_at: "2026-01-01" }], "FROM applications WHERE id::text": [{ credit_summary_submitted_at: null, signed_at: null }] });
    const snap = await readReadinessSnapshot({ pool, applicationId: "a1" });
    expect(snap.allDocsAccepted).toBe(false);
  });
  it("is not blocked once every required document is in, and never queries document_requirements", async () => {
    outstanding.value = { stillNeeded: [], rejected: [], required: [{ document_type: "bank_statements" }] };
    const pool = fakePool({ "application_tasks": [{ open_count: "0" }] });
    const snap = await readReadinessSnapshot({ pool, applicationId: "a1" });
    expect(snap.allDocsAccepted).toBe(true);
    expect(pool.query.mock.calls.some((c: unknown[]) => String(c[0]).includes("document_requirements"))).toBe(false);
  });
  it("a rejected document holds the file", async () => {
    outstanding.value = { stillNeeded: [], rejected: [{ document_type: "void_cheque" }], required: [] };
    const snap = await readReadinessSnapshot({ pool: fakePool({}), applicationId: "a1" });
    expect(snap.allDocsAccepted).toBe(false);
  });
});
