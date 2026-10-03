// BF_SERVER_REPORTS_BATCH4_v722
import { describe, it, expect, vi } from "vitest";
const calls: string[] = [];
vi.mock("../db.js", () => ({ pool: { query: vi.fn(async (sql: string) => { calls.push(sql); return { rows: [] }; }) } }));
import { declineReasons, documentTurnaround } from "../services/reports/data3.js";
import { catalogFor } from "../services/reports/catalog.js";

describe("decline reasons and document turnaround", () => {
  it("decline reasons come from the reasons staff pick (per lender and whole file)", async () => {
    await declineReasons({});
    expect(calls.at(-1)).toContain("FROM application_rejection_reasons r");
    expect(calls.at(-1)).toContain("FILTER (WHERE r.lender_id IS NULL)");
  });
  it("turnaround runs from each required document to the first upload in its category", async () => {
    await documentTurnaround({});
    expect(calls.at(-1)).toContain("FROM application_required_documents rd");
    expect(calls.at(-1)).toContain("percentile_cont(0.5)");
  });
  it("both are operations reports everyone can add", () => {
    const keys = catalogFor("Staff").map((r) => r.key);
    expect(keys).toContain("decline_reasons");
    expect(keys).toContain("document_turnaround");
  });
});
