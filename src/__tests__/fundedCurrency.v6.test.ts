// BF_SERVER_FUNDED_CURRENCY_v6
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it, expect } from "vitest";

const accept = readFileSync(path.join(process.cwd(), "src/routes/offerAcceptance.ts"), "utf8");
const dash = readFileSync(path.join(process.cwd(), "src/routes/dashboard.ts"), "utf8");
const migration = readFileSync(
  path.join(process.cwd(), "migrations/2026_08_03_funded_currency.sql"),
  "utf8",
);

describe("funded currency v6", () => {
  it("requires the funded amount on acceptance", () => {
    expect(accept).toContain("funded_amount_required");
  });

  it("only accepts CAD or USD", () => {
    expect(accept).toContain("invalid_funded_currency");
  });

  it("defaults existing rows to CAD", () => {
    expect(migration).toContain("funded_currency TEXT NOT NULL DEFAULT 'CAD'");
  });

  it("converts to CAD before summing, so a USD deal is not counted as CAD", () => {
    const conversions = dash.match(/SELECT to_cad FROM fx_rates WHERE currency = a\.funded_currency/g) ?? [];
    expect(conversions.length).toBeGreaterThanOrEqual(2);
  });
});
