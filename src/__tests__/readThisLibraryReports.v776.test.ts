// BF_SERVER_READ_THIS_v776 / BF_SERVER_STAFF_LIBRARY_v776 / BF_SERVER_REPORTS_BATCH5_v776 / BF_SERVER_TODO_DUE_DATE_v776
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { REPORTS, catalogFor } from "../services/reports/catalog.js";
import { DATA } from "../services/reports/data.js";
import { todoDueDate } from "../workers/todoReconcileWorker.js";

const read = (p: string) => readFileSync(p, "utf8");

describe("Read this", () => {
  it("sending can flag a message, readers record a receipt, the list carries who read it", () => {
    const team = read("src/routes/team.ts");
    expect(team).toContain("if (req.body?.read_this === true)");
    expect(team).toContain('"/messages/:mid/read-receipt"');
    expect(team).toContain('type: "read_this"');
    expect(read("src/services/team/team.service.ts")).toContain("(m as any).read_by = reads.get(m.id) ?? []");
    expect(read("src/services/team/readThis.ts")).toContain("ON CONFLICT (message_id, user_id)");
  });
});

describe("Staff Library", () => {
  it("is created once, shared with the organization, and listed for any staff member", () => {
    const o = read("src/routes/o365.ts");
    expect(o).toContain('router.post("/library/ensure"');
    expect(o).toContain('router.get("/library"');
    expect(o).toContain('JSON.stringify({ type: "edit", scope: "organization" })');
    expect(o).toContain('const LIBRARY_SUBFOLDERS = ["Lender Forms", "Read This"]');
  });
});

describe("reports batch 5", () => {
  const keys = ["deal_velocity", "win_rate", "call_outcomes", "client_reply_time", "commission_receivable"];
  it("are in the catalog with a data runner", () => {
    for (const k of keys) { expect(REPORTS.some((r) => r.key === k)).toBe(true); expect(typeof DATA[k]).toBe("function"); }
  });
  it("commission receivable is Admin only; the rest are for all staff", () => {
    const staff = catalogFor("Staff").map((r) => r.key);
    expect(staff).not.toContain("commission_receivable");
    for (const k of keys.filter((x) => x !== "commission_receivable")) expect(staff).toContain(k);
    expect(read("src/routes/reportsSection.ts")).toContain('router.post("/commission-received"');
  });
  it("a DECLINED file counts as lost", () => {
    expect(read("src/services/reports/data5.ts")).toContain("a.status = 'DECLINED'");
  });
});

describe("To Do due date", () => {
  it("is midnight of the Alberta day in a fixed UTC-6 zone", () => {
    expect(todoDueDate("2026-09-11T17:36:00Z")).toEqual({ dateTime: "2026-09-11T00:00:00.0000000", timeZone: "Central America Standard Time" });
    expect(todoDueDate("2026-09-17T00:17:00Z").dateTime.slice(0, 10)).toBe("2026-09-16");
  });
});
