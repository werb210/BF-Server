// BF_SERVER_BLOCK_v466_RANGE_AMOUNTS + BF_SERVER_BLOCK_v466_SIGNATURE_NEEDED
import request from "supertest";
import { describe, it, expect, vi } from "vitest";
import { amountOrRange, loadApplicationForPdf } from "../signnow/sendApplicationForSignature.js";
import { buildApplicationPdf } from "../signnow/pdfBuilder.js";
import { answerBySql, callsMatching } from "./helpers/answerBySql.js";
import { pdfTextRuns } from "./helpers/pdfText.js";
import { APP_ID, PARAM_GUARD_RULE, buildV1App, clientToken } from "./helpers/v1AppsHarness.js";

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));
vi.mock("../db.js", () => ({
  pool: { query: queryMock, connect: async () => ({ query: queryMock, release: () => undefined }) },
  runQuery: queryMock,
  dbQuery: queryMock,
}));
vi.mock("../services/clientEmail.js", () => ({ crmContactEmail: vi.fn(async () => null) }));

describe("v466 range answers print as written on the signing form", () => {
  it("a Step 1 range keeps both ends with a dash", () => {
    expect(amountOrRange("$250,000 to $500,000")).toBe("$250,000 - $500,000");
    expect(amountOrRange("$100,001 to $250,000")).toBe("$100,001 - $250,000");
    expect(amountOrRange("250,000 - 500,000")).toBe("250,000 - 500,000");
  });

  it("worded answers stay as text", () => {
    expect(amountOrRange("Over $500,000")).toBe("Over $500,000");
    expect(amountOrRange("No Account Receivables")).toBe("No Account Receivables");
  });

  it("a plain amount is still a number", () => {
    expect(amountOrRange("$75,000")).toBe(75000);
    expect(amountOrRange(120000)).toBe(120000);
    expect(amountOrRange("")).toBeNull();
    expect(amountOrRange(null)).toBeNull();
  });

  it("the form uses it for all three range fields", async () => {
    queryMock.mockReset();
    queryMock.mockImplementation(
      answerBySql([
        [/SELECT id, name, requested_amount, product_category, metadata FROM applications/, {
          rows: [{
            id: APP_ID, name: "Acme", requested_amount: "100000", product_category: "LOC",
            metadata: { kyc: { arBalance: "$100,001 to $250,000", fixedAssets: "Over $500,000", availableCollateral: "$75,000" }, applicant: { firstName: "Ann" } },
          }],
        }],
      ]),
    );
    const inputs = await loadApplicationForPdf(APP_ID);
    // accountsReceivable falls back to arBalance when the wizard stored it there.
    expect(inputs.funding).toMatchObject({ accountsReceivable: "$100,001 - $250,000", fixedAssets: "Over $500,000", availableCollateral: 75000 });

    // The signing PDF prints a range as written and a number as money.
    const runs = await pdfTextRuns(await buildApplicationPdf(inputs));
    expect(runs).toContain("$100,001 - $250,000");
    expect(runs).toContain("Over $500,000");
    expect(runs).toContain("$75,000");
    expect(runs.join(" ")).not.toContain("$100,001,250,000");
  });

  it("the client's application list says which one needs a signature", async () => {
    vi.resetModules();
    queryMock.mockReset();
    const row = { id: APP_ID, pipeline_state: "Off to Lender", business_name: "Acme", signature_needed: true };
    queryMock.mockImplementation(answerBySql([PARAM_GUARD_RULE, [/AS signature_needed/, { rows: [row] }]]));
    const res = await request(await buildV1App()).get("/api/client/applications/by-phone").set("Authorization", `Bearer ${clientToken()}`);
    expect(res.status).toBe(200);
    expect(res.body.applications[0]).toMatchObject({ id: APP_ID, signature_needed: true });
    const sql = String(callsMatching(queryMock, /AS signature_needed/)[0]![0]);
    expect(sql).toMatch(/\(a\.signnow_app_signed_at IS NULL AND EXISTS \([\s\S]+s\.finalized_at IS NOT NULL\s+\)\) AS signature_needed/);
  });
});
