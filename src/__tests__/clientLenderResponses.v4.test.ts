// BF_SERVER_CLIENT_LENDER_RESPONSES_v4
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it, expect } from "vitest";

const route = readFileSync(
  path.join(process.cwd(), "src/routes/client/v1Applications.ts"),
  "utf8",
);

describe("client lender responses v4", () => {
  it("checks ownership before reading outcomes", () => {
    // A token proves who the caller is, not which application they may read.
    expect(route).toContain('\"/application/:id/lender-responses\"');
    expect(route).toContain("Application not found.");
    const idx = route.indexOf('\"/application/:id/lender-responses\"');
    const segment = route.slice(idx, idx + 2200);
    expect(segment.indexOf("owns.rows.length")).toBeLessThan(
      segment.indexOf("FROM application_lender_responses"),
    );
  });

  it("never returns the lender identity to the client", () => {
    const idx = route.indexOf('\"/application/:id/lender-responses\"');
    const segment = route.slice(idx, idx + 2200);
    expect(segment).toContain("SELECT ordinal, outcome, reason, created_at");
    expect(segment).not.toContain("lender_id");
  });
});
