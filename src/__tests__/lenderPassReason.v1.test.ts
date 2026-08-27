import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const routes = readFileSync(
  fileURLToPath(new URL("../modules/applications/applications.routes.ts", import.meta.url)),
  "utf-8",
);
const migration = readFileSync(
  fileURLToPath(new URL("../../migrations/2026_07_31_v2831_lender_pass_reason.sql", import.meta.url)),
  "utf-8",
);

describe("BF_SERVER_LENDER_PASS_REASON_v1", () => {
  it("creates the table idempotently with one response per lender", () => {
    expect(migration).toContain("CREATE TABLE IF NOT EXISTS application_lender_responses");
    expect(migration).toContain("UNIQUE (application_id, lender_id)");
  });

  it("orders lenders by when the package actually went out", () => {
    expect(routes).toContain("row_number() OVER (ORDER BY MIN(sent_at) ASC");
  });

  it("freezes the ordinal so later sends cannot renumber old bubbles", () => {
    expect(routes).toContain("frozenOrdinal");
  });

  it("refuses a lender that never received the package", () => {
    expect(routes).toContain("No package was sent to that lender.");
  });

  it("tells the client the ordinal and never the lender", () => {
    // BF_SERVER_PASS_ORDINAL_v127 - wording changed in v124, the contract did not.
    expect(routes).toContain("will pass, due to");
    expect(routes).toContain("Lender ${frozenOrdinal}");
  });

  it("still never names the lender in the client bubble", () => {
    const i = routes.indexOf("will pass, due to");
    const bubble = routes.slice(Math.max(0, i - 200), i + 600);
    expect(bubble).not.toContain("lender_name");
    expect(bubble).not.toContain("lenderName");
  });

  it("both routes require staff auth", () => {
    expect(routes).toContain("'/:id/lender-response', requireAuth");
    expect(routes).toContain("'/:id/lender-responses', requireAuth");
  });
});
