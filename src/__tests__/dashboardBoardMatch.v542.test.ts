// BF_SERVER_BLOCK_v542 - dashboard matches the Pipeline board; one row per call; named client-app voicemails.
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import { collapseOutboundLegs } from "../routes/voiceCalls.js";
import { boardScope } from "../routes/dashboard.js";

const dash = fs.readFileSync("src/routes/dashboard.ts", "utf8");

describe("v542 dashboard", () => {
  it("reads the silo the user selected (Insurance/SLF no longer show BF numbers)", () => {
    expect(dash).not.toContain("getSilo(res)");
    expect((dash.match(/resolveSiloFromRequest\(req\)/g) ?? []).length).toBeGreaterThanOrEqual(8);
  });
  it("counts exactly what the Pipeline board shows", () => {
    const sql = boardScope("a");
    expect(sql).toContain("a.parent_application_id IS NULL OR a.source IN ('closing_costs_companion', 'capital_and_equipment_leg')");
    expect(sql).toContain("FROM companies bc WHERE bc.id = a.company_id");
    expect(sql).toContain("OR a.submitted_at IS NOT NULL");
    expect(dash).not.toContain("NULLIF(TRIM(business_legal_name), '')) IS NOT NULL");
    expect((dash.match(/boardScope\("(applications|a)"\)/g) ?? []).length).toBeGreaterThanOrEqual(8);
  });
  it("deals won this month use the date the file moved to Accepted", () => {
    expect(dash).toContain("FROM application_stage_history h");
    expect(dash).not.toMatch(/AND updated_at >= date_trunc\('month', now\(\)\)/);
  });
  it("new leads today is a real count, not a hard-coded 0", () => {
    expect(dash).not.toContain("newLeadsToday: 0");
    expect(dash).toContain("SELECT COUNT(*)::text AS count FROM contacts");
  });
  it("pending documents are not counted as upload issues", () => {
    expect(dash).not.toContain("OR d.status NOT IN ('accepted','rejected')");
  });
});

describe("v542 one row per outbound call", () => {
  const rows = [
    { id: "e1", direction: "outbound", created_at: "2026-09-25T17:04:23Z", duration_seconds: 563, phone_number: null, contact_id: "c-jeremy", contact_name: "Jeremy Girard" },
    { id: "s1", direction: "outbound", created_at: "2026-09-25T16:55:05Z", duration_seconds: null, phone_number: "+12633821005", contact_id: "c-jeremy", contact_name: "Jeremy Girard" },
    { id: "e2", direction: "outbound", created_at: "2026-09-24T16:10:00Z", duration_seconds: 343, phone_number: null, contact_id: null, contact_name: "Lorne Benjamin" },
    { id: "s2", direction: "outbound", created_at: "2026-09-24T16:04:20Z", duration_seconds: null, phone_number: "+14035550101", contact_id: "c-lorne", contact_name: "Lorne Benjamin" },
    { id: "i1", direction: "inbound", created_at: "2026-09-24T16:03:00Z", duration_seconds: 87, phone_number: "+14035550101", contact_id: null, contact_name: "Lorne Benjamin" },
    { id: "n1", direction: "outbound", created_at: "2026-09-20T10:00:00Z", duration_seconds: null, phone_number: "+15875550199", contact_id: null, contact_name: null },
  ];
  it("pairs the start row with the ended row and keeps one, dated at the start, with the number", () => {
    const out = collapseOutboundLegs(rows);
    expect(out.map((r) => r.id)).toEqual(["e1", "e2", "i1", "n1"]);
    expect(out[0]).toMatchObject({ phone_number: "+12633821005", duration_seconds: 563, created_at: "2026-09-25T16:55:05Z" });
    expect(out[1]).toMatchObject({ phone_number: "+14035550101", contact_id: "c-lorne" });
  });
  it("leaves inbound calls and unanswered attempts with no ended row alone", () => {
    const out = collapseOutboundLegs(rows);
    expect(out.find((r) => r.id === "i1")).toBeTruthy();
    expect(out.find((r) => r.id === "n1")).toBeTruthy();
  });
});

describe("v542 voicemails from the client app are named", () => {
  it("resolves client:client-<applicationId>, website callers and staff rings", () => {
    const vm = fs.readFileSync("src/routes/crm/voicemails.ts", "utf8");
    expect(vm).toContain("^client:client-[0-9a-f-]{36}$");
    expect(vm).toContain("Website visitor (Call us button)");
    expect(vm).toContain("CASE WHEN v.from_number ILIKE 'client:%' THEN NULL ELSE v.from_number END");
  });
});
