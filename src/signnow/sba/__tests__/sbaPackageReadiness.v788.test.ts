// BF_SERVER_SBA_PACKAGE_READINESS_v788
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { decideSbaPackageBlock, ivesFallbackConfigured, type SbaPackageInput } from "../sbaPackageReadiness.js";

const read = (p: string) => readFileSync(path.join(process.cwd(), p), "utf8");
const base: SbaPackageInput = {
  isSba: true, signnowConfigured: true, docsOutstanding: [], openTasks: 0,
  envelopes: [{ ives4506cLenderIds: ["L1"] }], ivesLenders: [{ lenderId: "L1", lenderName: "Todd's lending company" }],
  signedForDispatch: true,
};

describe("SBA package readiness decision", () => {
  it("never touches a non-SBA file", () => {
    expect(decideSbaPackageBlock({ ...base, isSba: false, envelopes: [], docsOutstanding: ["x"], signedForDispatch: false })).toBeNull();
  });
  it("lets a complete, signed SBA file through", () => {
    expect(decideSbaPackageBlock(base)).toBeNull();
  });
  it("holds until staff press Send for signing", () => {
    expect(decideSbaPackageBlock({ ...base, envelopes: [] })?.reason).toBe("sba_signing_not_started");
  });
  it("holds on outstanding documents or open client tasks and names them", () => {
    const d = decideSbaPackageBlock({ ...base, docsOutstanding: ["Personal tax returns"], openTasks: 2 });
    expect(d?.reason).toBe("preconditions_not_met");
    expect(d?.detail).toContain("Personal tax returns");
    expect(d?.detail).toContain("2 open client tasks");
  });
  it("holds when a selected IVES lender has no 4506-C in the signed envelopes", () => {
    const d = decideSbaPackageBlock({ ...base, ivesLenders: [...base.ivesLenders, { lenderId: "L2", lenderName: "Pathward" }] });
    expect(d).toEqual({ reason: "sba_4506c_missing_for_lender", detail: "Pathward" });
  });
  it("holds when no envelope carries any 4506-C", () => {
    expect(decideSbaPackageBlock({ ...base, envelopes: [{ ives4506cLenderIds: [] }], ivesLenders: [] })?.reason).toBe("sba_4506c_missing");
  });
  it("accepts the single-lender env fallback when no selected lender has IVES details", () => {
    expect(decideSbaPackageBlock({ ...base, envelopes: [{ ives4506cLenderIds: ["__env__"] }], ivesLenders: [] })).toBeNull();
  });
  it("holds while the envelopes are unsigned (or a 4506-C is past 120 days)", () => {
    expect(decideSbaPackageBlock({ ...base, signedForDispatch: false })?.reason).toBe("sba_forms_not_signed");
  });
  it("without SignNow configured only the document gate applies", () => {
    expect(decideSbaPackageBlock({ ...base, signnowConfigured: false, envelopes: [], signedForDispatch: false })).toBeNull();
    expect(decideSbaPackageBlock({ ...base, signnowConfigured: false, envelopes: [], openTasks: 1 })?.reason).toBe("preconditions_not_met");
  });
  it("reports the env fallback only when all three IVES fields are set", () => {
    expect(ivesFallbackConfigured({ SBA_IVES_PARTICIPANT_NAME: "a", SBA_IVES_PARTICIPANT_ID: "b" } as any)).toBe(false);
    expect(ivesFallbackConfigured({ SBA_IVES_PARTICIPANT_NAME: "a", SBA_IVES_PARTICIPANT_ID: "b", SBA_IVES_SOR_MAILBOX_ID: "c" } as any)).toBe(true);
  });
});

describe("every package path asks it", () => {
  it("the staff Send (stage B) holds before the signed check", () => {
    const o = read("src/services/submission/orchestrator.ts");
    const stageB = o.slice(o.indexOf("export async function maybeBuildAndSendPackage"));
    expect(stageB.indexOf("sbaPackageBlocker(ctx.applicationId)")).toBeGreaterThan(0);
    expect(stageB.indexOf("sbaPackageBlocker(ctx.applicationId)")).toBeLessThan(stageB.indexOf("application_not_signed"));
  });
  it("the package worker holds after the signing gates", () => {
    const w = read("src/workers/lenderPackageWorker.ts");
    expect(w).toContain("sbaPackageBlocker(applicationId, { signingChecked: true })");
    expect(w.indexOf("sbaSigningSatisfiedForDispatch(applicationId)")).toBeLessThan(w.indexOf("sbaPackageBlocker(applicationId"));
  });
  it("Send for signing clears the old signed stamp once new envelopes exist", () => {
    const t = read("src/signnow/sba/sbaTrigger.ts");
    const send = t.slice(t.indexOf("export async function sendSbaForSigning"), t.indexOf("async function notifyOwnerOne"));
    expect(send).toContain("signnow_app_signed_at = NULL");
    expect(send).toContain("if (owners.some((o) => o.started))");
    expect(send.indexOf("createSbaSigningSessions")).toBeLessThan(send.indexOf("signnow_app_signed_at = NULL"));
  });
  it("the SBA Signing tab learns who the 4506-C names and what holds the package", () => {
    const r = read("src/routes/applicationFormResponses.ts");
    expect(r).toContain("selectedLenders, ivesFallback: ivesFallbackConfigured(), packageBlock");
  });
});
