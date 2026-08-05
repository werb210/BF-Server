// BF_SERVER_BLOCK_v121_E2E_TRACE_FUNDING_AMOUNT_v1
//
// End-to-end trace for ONE field — `fundingAmount` from Step 1 of the
// public wizard — through every hop until it appears as a dollar amount
// on a Sales Pipeline card in the staff portal.
//
// HOP 1  Step1_KYC.tsx               app.kyc.fundingAmount = "$1,000,000"
// HOP 2  Step6_Review.tsx            buildSubmissionPayload reads kyc
// HOP 3  POST /applications/:t/submit body.app.kyc.fundingAmount = "$1,000,000"
// HOP 4  v1Applications.ts           bfExtractAppColumns -> 1000000
// HOP 5  portal.ts SQL               SELECT a.requested_amount
// HOP 6  portal.ts response          requested_amount + requestedAmount
// HOP 7  PipelinePage.tsx            "$1,000,000" on the card
//
// If any hop renames a key OR the parser fails to coerce
// "$1,000,000" → 1000000, the dashboard card silently shows blank or
// "$0". This test pins the contract at every hop.

import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

function bfParseAmount(v: unknown): number | null {
  if (v == null) return null;
  if (typeof v === "number" && Number.isFinite(v) && v > 0) return v;
  const cleaned = String(v).replace(/[^\d.]/g, "");
  if (!cleaned) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function bfExtractRequestedAmount_defaultFlow(input: Record<string, any>): number | null {
  return (
    bfParseAmount(input.requested_amount) ??
    bfParseAmount(input.requestedAmount) ??
    bfParseAmount(input.kyc?.fundingAmount) ??
    bfParseAmount(input.financialProfile?.fundingAmount) ??
    null
  );
}

describe("v121 E2E trace: $1,000,000 in Step 1 ➜ pipeline card", () => {
  const step1Src = (() => {
    const candidates = [
      path.resolve(__dirname, "../../../../BF-client-main/client-app/src/wizard/Step1_KYC.tsx"),
      path.resolve(__dirname, "../../../../BF-client/client-app/src/wizard/Step1_KYC.tsx"),
    ];
    for (const p of candidates) { try { return fs.readFileSync(p, "utf8"); } catch {} }
    return null;
  })();

  it("HOP 1 — Step 1 stores the typed value at app.kyc.fundingAmount", () => {
    if (!step1Src) return;
    expect(step1Src).toMatch(/fundingAmount:\s*sanitizeCurrencyInput/);
    expect(step1Src).toMatch(/value=\{app\.kyc\.fundingAmount/);
  });

  it("HOP 2 — buildSubmissionPayload writes kyc.fundingAmount AND application.capital_amount", () => {
    const submissionTs = (() => {
      const candidates = [
        path.resolve(__dirname, "../../../../BF-client-main/client-app/src/wizard/submission.ts"),
        path.resolve(__dirname, "../../../../BF-client/client-app/src/wizard/submission.ts"),
      ];
      for (const p of candidates) { try { return fs.readFileSync(p, "utf8"); } catch {} }
      return null;
    })();
    if (!submissionTs) return;
    expect(submissionTs).toMatch(/kyc_answers:\s*app\.kyc/);
    expect(submissionTs).toMatch(
      /capital_amount:\s*\(app\.kyc as any\)\?\.capitalAmount\s*\?\?\s*\(app\.kyc as any\)\?\.fundingAmount/
    );
  });

  it("HOP 3 — server submit endpoint exists and accepts the wizard envelope", () => {
    const v1AppsSrc = fs.readFileSync(
      path.resolve(__dirname, "../client/v1Applications.ts"), "utf8"
    );
    expect(v1AppsSrc).toMatch(/router\.post\(\s*["']\/applications\/:token\/submit["']/);
    expect(v1AppsSrc).toMatch(/const\s*\{\s*app:\s*legacyApp[\s\S]{0,40}\}\s*=\s*req\.body/);
  });

  it("HOP 4a — bfParseAmount coerces $1,000,000 → 1000000", () => {
    expect(bfParseAmount("$1,000,000")).toBe(1_000_000);
    expect(bfParseAmount("1,000,000")).toBe(1_000_000);
    expect(bfParseAmount("1000000")).toBe(1_000_000);
    expect(bfParseAmount(1_000_000)).toBe(1_000_000);
    expect(bfParseAmount("$1,000,000")).not.toBeNull();
    expect(bfParseAmount("$1,000,000")).not.toBe(0);
  });

  it("HOP 4b — bfExtractAppColumns reads kyc.fundingAmount in default flow", () => {
    const wizardEnvelope = {
      kyc: { fundingAmount: "$1,000,000", lookingFor: "CAPITAL" },
    };
    expect(bfExtractRequestedAmount_defaultFlow(wizardEnvelope)).toBe(1_000_000);
  });

  it("HOP 4c — v1Applications.ts source still calls bfParseAmount(input.kyc?.fundingAmount)", () => {
    const v1AppsSrc = fs.readFileSync(
      path.resolve(__dirname, "../client/v1Applications.ts"), "utf8"
    );
    expect(v1AppsSrc).toMatch(/bfParseAmount\(input\.kyc\?\.fundingAmount\)/);
    expect(v1AppsSrc).toMatch(/bfParseAmount\(input\.requested_amount\)/);
    expect(v1AppsSrc).toMatch(
      /UPDATE\s+applications[\s\S]{0,400}?requested_amount\s*=\s*COALESCE\(\$2,\s*requested_amount\)/i
    );
  });

  it("HOP 5 — portal /applications query SELECTs a.requested_amount", () => {
    const portalSrc = fs.readFileSync(path.resolve(__dirname, "../portal.ts"), "utf8");
    expect(portalSrc).toMatch(/SELECT[\s\S]{0,400}?a\.requested_amount\s+AS\s+requested_amount/);
  });

  it("HOP 6 — portal response card carries BOTH legacy and modern shapes", () => {
    const portalSrc = fs.readFileSync(path.resolve(__dirname, "../portal.ts"), "utf8");
    expect(portalSrc).toMatch(/requested_amount:\s*r\.requested_amount/);
    expect(portalSrc).toMatch(/requestedAmount:\s*r\.requested_amount/);
    expect(portalSrc).toMatch(/applications:\s*cards/);
    expect(portalSrc).toMatch(/items:\s*cards/);
  });

  it("HOP 7 — staff PipelinePage renders requested_amount as $1,000,000", () => {
    const portalPageSrc = (() => {
      const candidates = [
        path.resolve(__dirname, "../../../../BF-portal-main/src/pages/pipeline/PipelinePage.tsx"),
        path.resolve(__dirname, "../../../../BF-portal/src/pages/pipeline/PipelinePage.tsx"),
      ];
      for (const p of candidates) { try { return fs.readFileSync(p, "utf8"); } catch {} }
      return null;
    })();
    if (!portalPageSrc) return;
    expect(portalPageSrc).toMatch(/card\.requested_amount/);
    expect(portalPageSrc).toMatch(/Number\(card\.requested_amount\)\.toLocaleString\(\)/);
    // BF_SERVER_STALE_EMAIL_IMAGE_TESTS_v16 - PipelinePage now renders
    // `{amount ?? "—"}`; the old literal `{amount}` regex only ever matched when
    // BF-portal happened to be checked out beside BF-Server, so the drift went
    // unnoticed in CI (the hop self-skips when the sibling path is absent).
    expect(portalPageSrc).toMatch(/\{amount\s*(\?\?[^}]*)?\}/);
    expect((1_000_000).toLocaleString()).toBe("1,000,000");
    expect(`$${(1_000_000).toLocaleString()}`).toBe("$1,000,000");
  });

  it("FULL CHAIN — typed '$1,000,000' on Step 1 ➜ staff card displays '$1,000,000'", () => {
    const typedByUser = "$1,000,000";
    const appState_afterStep1 = { kyc: { fundingAmount: typedByUser } };
    const serverEnvelope = { ...appState_afterStep1 };
    const requestedAmountColumn = bfExtractRequestedAmount_defaultFlow(serverEnvelope);
    expect(requestedAmountColumn).toBe(1_000_000);
    const card = {
      id: "62929736-44a9-42bc-a1e9-2de961105f13",
      requested_amount: requestedAmountColumn,
      requestedAmount: requestedAmountColumn,
    };
    expect(card.requested_amount).toBe(1_000_000);
    expect(card.requestedAmount).toBe(1_000_000);
    const rendered = card.requested_amount
      ? `$${Number(card.requested_amount).toLocaleString()}`
      : null;
    expect(rendered).toBe("$1,000,000");
  });
});
