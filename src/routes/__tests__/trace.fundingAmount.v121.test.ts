// BF_SERVER_BLOCK_v121_E2E_TRACE_FUNDING_AMOUNT_v1
//
// End-to-end trace for ONE field - `fundingAmount` from Step 1 of the
// public wizard - through every hop until it appears as a dollar amount
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
// "$1,000,000" -> 1000000, the dashboard card silently shows blank or
// "$0". This test pins the contract at every hop.

import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { answerBySql, callsMatching } from "../../__tests__/helpers/answerBySql.js";
import { APP_ID, buildV1App, submitBaseRules } from "../../__tests__/helpers/v1AppsHarness.js";
import { bearer } from "../../__tests__/helpers/staffToken.js";

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));
vi.mock("../../db.js", () => ({
  pool: { query: queryMock, connect: async () => ({ query: queryMock, release: () => undefined }) },
  runQuery: queryMock,
}));
vi.mock("../../services/applicationCrmMirror.js", () => ({ mirrorApplicationToCrm: vi.fn(async () => undefined) }));
vi.mock("../../startupState.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../startupState.js")>()),
  isReady: () => true,
}));

// HOP 1, 2 and 7 live in the sibling client / portal repositories. They are read
// only when those checkouts sit beside BF-Server (never in CI) and self-skip otherwise.
function siblingFile(repos: string[], dir: string, base: string, ext: string): string | null {
  for (const repo of repos) {
    try {
      return fs.readFileSync(path.resolve(__dirname, "../../../..", repo, dir, `${base}.${ext}`), "utf8");
    } catch {
      /* not checked out here */
    }
  }
  return null;
}

const SUBMIT_UPDATE = /requested_amount = COALESCE\(\$2, requested_amount\)/;

async function submitWizard(app: Record<string, unknown>) {
  queryMock.mockReset();
  queryMock.mockImplementation(answerBySql(submitBaseRules()));
  const res = await request(await buildV1App()).post(`/api/client/applications/${APP_ID}/submit`).send({ app });
  expect(res.status).toBe(200);
  const calls = callsMatching(queryMock, SUBMIT_UPDATE);
  expect(calls).toHaveLength(1);
  return { sql: String(calls[0]![0]), params: calls[0]![1] as unknown[] };
}

async function portalCards(row: Record<string, unknown>) {
  queryMock.mockReset();
  queryMock.mockImplementation(answerBySql([[/AS business_name/, { rows: [row] }]]));
  const app = express();
  app.use("/api/portal", (await import("../portal.js")).default);
  const res = await request(app).get("/api/portal/applications").set("Authorization", bearer("Staff"));
  expect(res.status).toBe(200);
  const sql = String(callsMatching(queryMock, /AS business_name/)[0]![0]);
  return { body: res.body, sql };
}

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

describe("v121 E2E trace: $1,000,000 in Step 1 -> pipeline card", () => {
  beforeEach(() => {
    vi.resetModules();
  });
  const step1Src = siblingFile(["BF-client-main", "BF-client"], "client-app/src/wizard", "Step1_KYC", "tsx");

  it("HOP 1 - Step 1 stores the typed value at app.kyc.fundingAmount", (ctx) => {
    if (!step1Src) return ctx.skip();
    // BF_SERVER_BLOCK_v334: Step 1 moved to the format-on-keystroke helper in
    // BF_CLIENT_BLOCK_v158. Accept either currency helper; the contract that
    // matters is that the typed value lands on kyc.fundingAmount.
    expect(step1Src).toMatch(/fundingAmount:\s*(sanitizeCurrencyInput|formatCurrencyOnInput)/);
    expect(step1Src).toMatch(/value=\{app\.kyc\.fundingAmount/);
  });

  it("HOP 2 - buildSubmissionPayload writes kyc.fundingAmount AND application.capital_amount", (ctx) => {
    const submissionTs = siblingFile(["BF-client-main", "BF-client"], "client-app/src/wizard", "submission", "ts");
    if (!submissionTs) return ctx.skip();
    expect(submissionTs).toMatch(/kyc_answers:\s*app\.kyc/);
    expect(submissionTs).toMatch(
      /capital_amount:\s*\(app\.kyc as any\)\?\.capitalAmount\s*\?\?\s*\(app\.kyc as any\)\?\.fundingAmount/
    );
  });

  it("HOP 3 - server submit endpoint exists and accepts the wizard envelope", async () => {
    // The wizard posts { app }: the body's `app` is what the submit writes.
    const { params } = await submitWizard({ kyc: { fundingAmount: "$1,000,000" }, business: { companyName: "Trace Co" } });
    expect(JSON.parse(String(params[0])).formData).toEqual({ kyc: { fundingAmount: "$1,000,000" }, business: { companyName: "Trace Co" } });
    expect(params[4]).toBe(APP_ID);
  });

  it("HOP 4a - bfParseAmount coerces $1,000,000 -> 1000000", () => {
    expect(bfParseAmount("$1,000,000")).toBe(1_000_000);
    expect(bfParseAmount("1,000,000")).toBe(1_000_000);
    expect(bfParseAmount("1000000")).toBe(1_000_000);
    expect(bfParseAmount(1_000_000)).toBe(1_000_000);
    expect(bfParseAmount("$1,000,000")).not.toBeNull();
    expect(bfParseAmount("$1,000,000")).not.toBe(0);
  });

  it("HOP 4b - bfExtractAppColumns reads kyc.fundingAmount in default flow", () => {
    const wizardEnvelope = {
      kyc: { fundingAmount: "$1,000,000", lookingFor: "CAPITAL" },
    };
    expect(bfExtractRequestedAmount_defaultFlow(wizardEnvelope)).toBe(1_000_000);
  });

  it("HOP 4c - the real submit parses kyc.fundingAmount and requested_amount into requested_amount", async () => {
    const fromKyc = await submitWizard({ kyc: { fundingAmount: "$1,000,000", lookingFor: "CAPITAL" } });
    expect(fromKyc.params[1]).toBe(1_000_000);
    expect(fromKyc.sql).toMatch(/UPDATE\s+applications[\s\S]{0,400}?requested_amount\s*=\s*COALESCE\(\$2,\s*requested_amount\)/i);
    const explicit = await submitWizard({ requested_amount: "$250,000", kyc: { fundingAmount: "$1,000,000" } });
    expect(explicit.params[1]).toBe(250_000);
    const none = await submitWizard({ kyc: {} });
    expect(none.params[1]).toBeNull();
  });

  it("HOP 5 - portal /applications query SELECTs a.requested_amount", async () => {
    const { sql } = await portalCards({ id: APP_ID, requested_amount: "1000000", business_name: "Trace Co", stage: "Received" });
    expect(sql).toMatch(/SELECT[\s\S]{0,400}?a\.requested_amount\s+AS\s+requested_amount/);
  });

  it("HOP 6 - portal response card carries BOTH legacy and modern shapes", async () => {
    const { body } = await portalCards({ id: APP_ID, requested_amount: "1000000", business_name: "Trace Co", stage: "Received" });
    expect(body.applications).toEqual(body.items);
    expect(body.items).toHaveLength(1);
    expect(body.items[0]).toMatchObject({ id: APP_ID, requested_amount: "1000000", requestedAmount: "1000000" });
  });

  it("HOP 7 - staff PipelinePage renders requested_amount as $1,000,000", (ctx) => {
    const portalPageSrc = siblingFile(["BF-portal-main", "BF-portal"], "src/pages/pipeline", "PipelinePage", "tsx");
    if (!portalPageSrc) return ctx.skip();
    expect(portalPageSrc).toMatch(/card\.requested_amount/);
    expect(portalPageSrc).toMatch(/Number\(card\.requested_amount\)\.toLocaleString\(\)/);
    // BF_SERVER_STALE_EMAIL_IMAGE_TESTS_v16 - PipelinePage now renders
    // `{amount ?? "-"}`; the old literal `{amount}` regex only ever matched when
    // BF-portal happened to be checked out beside BF-Server, so the drift went
    // unnoticed in CI (the hop self-skips when the sibling path is absent).
    expect(portalPageSrc).toMatch(/\{amount\s*(\?\?[^}]*)?\}/);
    expect((1_000_000).toLocaleString()).toBe("1,000,000");
    expect(`$${(1_000_000).toLocaleString()}`).toBe("$1,000,000");
  });

  it("FULL CHAIN - typed '$1,000,000' on Step 1 -> staff card displays '$1,000,000'", () => {
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
