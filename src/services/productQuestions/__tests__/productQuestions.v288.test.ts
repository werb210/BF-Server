// BF_SERVER_PRODUCT_QUESTIONS_v288
import { describe, expect, it, vi } from "vitest";
import { applyAnswers, computeGaps } from "../gaps.js";
import { questionSetFor } from "../registry.js";
import { saveAnswers } from "../service.js";

const app = { product_category: "LINE_OF_CREDIT", metadata: { applicant: { firstName: "Tanya", partner: { firstName: "Mark" } }, business: { legalName: "Voss Events Inc" }, kyc: {} } };
describe("product questions", () => {
  it("selects question sets by product and Accord match", () => {
    expect(questionSetFor("LINE_OF_CREDIT", true)).toBe("loc_accord");
    expect(questionSetFor("LOC", false)).toBeNull();
    expect(questionSetFor("EQUIPMENT_FINANCE", false)).toBe("equipment");
    expect(questionSetFor("TERM_LOAN", true)).toBeNull();
  });
  it("finds conditional gaps for each owner", () => {
    const initial = computeGaps(app, true);
    expect(initial.missing).toContain("owner.1.bankruptcyFiled");
    expect(initial.missing).not.toContain("owner.0.propertyValue");
    const result = applyAnswers(app.metadata, "loc_accord", { "owner.0.ownRent": "Own", "business.riskGovtArrears": "yes", "business.mailingSameAsOperating": "No" });
    const gaps = computeGaps({ ...app, metadata: result.metadata }, true);
    expect(gaps.missing).toContain("owner.0.propertyValue");
    expect(gaps.missing).toContain("business.riskGovtArrearsDetail");
    expect(gaps.missing).toContain("business.mailingCity");
  });
  it("writes partner answers and rejects unknown or invalid fields", () => {
    const result = applyAnswers(app.metadata, "loc_accord", { "owner.1.bankruptcyFiled": "No", "business.legalName": "Hacked", "owner.0.ownRent": "Lease" });
    expect(result.metadata.applicant.partner.bankruptcyFiled).toBe("No");
    expect(result.metadata.business.legalName).toBe("Voss Events Inc");
    expect(result.rejected).toEqual(["business.legalName", "owner.0.ownRent"]);
  });
  it("records staff edit provenance", async () => {
    let stored: any;
    const query = vi.fn(async (sql: string, params: unknown[]) => {
      if (sql.startsWith("SELECT product_category")) return { rows: [app] };
      if (sql.includes("jsonb_array_elements")) return { rows: [{ matched: true }] };
      stored = JSON.parse(String(params[1])); return { rows: [] };
    });
    await saveAnswers(query as any, "app-1", { "owner.0.ownRent": "Rent" }, { submit: false, by: "staff", userId: "u-1" });
    expect(stored.product_questions.loc_accord.staff_edits[0]).toMatchObject({ by: "u-1", fields: ["owner.0.ownRent"] });
  });
});
