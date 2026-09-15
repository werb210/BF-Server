// BF_SERVER_NAME_PARTS_v265
import { describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import { loadNamingContext, suggestedNameParts } from "../documentNaming.js";

describe("name parts for the Accept box", () => {
  it("splits the suggestion so staff only type the period", () => {
    expect(suggestedNameParts({ businessName: "Voss Events Inc", category: "6 months business banking statements", filename: "20260731-statements-5274-.pdf" }))
      .toEqual({ businessName: "Voss Events Inc", documentType: "Bank Statement", period: "2026-07", extension: ".pdf" });
  });
  it("leaves the period empty when the filename has none", () => {
    expect(suggestedNameParts({ businessName: null, category: "6 months business banking statements", filename: "Sept 1-11.pdf" }))
      .toEqual({ businessName: null, documentType: "Bank Statement", period: null, extension: ".pdf" });
  });
  it("is returned with the naming context", async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [{ id: "d1", application_id: "a1", filename: "Profit and Loss 4.30.26 (1).pdf", display_name: null, category: "PnL – Interim financials", detected_type: null, detected_confidence: null, business_name: "Voss Events Inc" }] })
      .mockResolvedValueOnce({ rows: [] });
    const ctx = await loadNamingContext("d1", query as any);
    expect(ctx?.parts).toEqual({ businessName: "Voss Events Inc", documentType: "Profit and Loss", period: "2026-04-30", extension: ".pdf" });
  });
  it("the suggested-name route sends the parts", () => {
    expect(fs.readFileSync("src/routes/portal.ts", "utf8")).toContain("parts: naming.parts");
  });
});
