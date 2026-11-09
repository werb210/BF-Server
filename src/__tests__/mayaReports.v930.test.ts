// BF_SERVER_v930_MAYA_REPORTS - question -> report card; the table spec is whitelisted.
import { describe, expect, it } from "vitest";
import { askReport, cleanSpec, keywordPick, runTable } from "../services/reports/mayaReports.js";
import { cleanCards } from "../routes/reportsSection.js";

const reply = (obj: unknown) => async () => ({ choices: [{ message: { content: JSON.stringify(obj) } }] });

describe("Maya reports", () => {
  it("accepts only whitelisted specs", () => {
    expect(cleanSpec({ object: "applications", group_by: "product", measure: "total_amount", days: 90 })).toEqual({ title: "Applications by product", object: "applications", group_by: "product", measure: "total_amount", days: 90 });
    expect(cleanSpec({ object: "contacts", group_by: "product" })).toBeNull();
    expect(cleanSpec({ object: "users", group_by: "stage" })).toBeNull();
    expect(cleanSpec({ object: "contacts", group_by: "tag", measure: "total_amount" })!.measure).toBe("count");
    expect(cleanSpec({ object: "applications", group_by: "stage; DROP TABLE x" })).toBeNull();
  });

  it("picks a catalog report or builds a table", async () => {
    expect(await askReport("which deals are stuck", "Admin", "BF", reply({ kind: "catalog", report: "stuck_deals", days: 30 }))).toEqual({ kind: "catalog", report: "stuck_deals", title: "Stuck deals", days: 30 });
    const t = await askReport("applications by product this quarter", "Admin", "BF", reply({ kind: "table", title: "Applications by product", object: "applications", group_by: "product", measure: "count", days: 90 }));
    expect(t).toMatchObject({ kind: "table", spec: { group_by: "product", days: 90 } });
    expect((await askReport("x", "Admin", "BF", reply({ kind: "table", object: "applications", group_by: "evil" }))).kind).toBe("none");
    expect((await askReport("x", "Staff", "BF", reply({ kind: "catalog", report: "commission_receivable" }))).kind).toBe("none"); // money: not for Staff
  });

  it("matches by words without the AI service", () => {
    expect(keywordPick("show me stuck deals", [{ key: "stuck_deals", title: "Stuck deals", description: "" }, { key: "x", title: "Other", description: "" }])).toBe("stuck_deals");
  });

  it("builds fixed SQL with the silo and period as parameters", async () => {
    const calls: Array<[string, unknown[]]> = [];
    const db = { query: async (sql: string, p: unknown[] = []) => { calls.push([sql, p]); return { rows: [{ label: "Equipment", value: 3 }] }; } };
    const out = await runTable({ title: "T", object: "applications", group_by: "product", measure: "count", days: 30 }, "BF", db);
    expect(out.rows).toEqual([{ label: "Equipment", value: 3 }]);
    expect(calls[0]![1]).toEqual(["BF", 30]);
    expect(calls[0]![0]).toContain("FROM applications x");
  });

  it("keeps a Maya table's spec on the saved card", () => {
    const cards = cleanCards("Staff", [{ id: "a", report: "maya_table", spec: { object: "contacts", group_by: "lead_status" } }, { id: "b", report: "maya_table", spec: { object: "nope" } }]);
    expect(cards[0]).toMatchObject({ report: "maya_table", spec: { object: "contacts", group_by: "lead_status" } });
    expect(cards[1]).not.toHaveProperty("spec");
  });
});
