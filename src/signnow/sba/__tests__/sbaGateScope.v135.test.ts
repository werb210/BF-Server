// BF_SERVER_SBA_GATE_SCOPE_v135
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const signing = readFileSync(resolve(__dirname, "..", "sbaSigning.ts"), "utf-8");
const trigger = readFileSync(resolve(__dirname, "..", "sbaTrigger.ts"), "utf-8");
const worker = readFileSync(resolve(__dirname, "..", "..", "..", "workers", "lenderPackageWorker.ts"), "utf-8");

const gate = signing.slice(
  signing.indexOf("export async function sbaSigningSatisfiedForDispatch"),
  signing.indexOf("export async function getSignedSbaPdfs"),
);

describe("the dispatch gate only gates SBA deals", () => {
  it("the worker calls it on every dispatch, so the scoping must live in the gate", () => {
    expect(worker).toContain("sbaSigningSatisfiedForDispatch(applicationId)");
    expect(worker).not.toContain("isSbaApplication");
  });

  it("asks whether this is an SBA application before demanding envelopes", () => {
    expect(gate).toContain("isSbaApplication");
    const ask = gate.indexOf("isSbaApplication");
    const demand = gate.indexOf("sba_dispatch_blocked_missing_envelope");
    expect(ask).toBeLessThan(demand);
  });

  it("lets a non-SBA application through", () => {
    expect(gate).toContain("if (!(await isSbaApplication(applicationId))) return true;");
  });

  it("keeps the v102 behaviour for SBA deals", () => {
    expect(gate).toContain("if (owners.length === 0) return false;");
    expect(gate).toContain("sba_dispatch_blocked_missing_envelope");
  });

  it("does not wave a package through when the SBA check itself fails", () => {
    const c = gate.slice(gate.indexOf("} catch {"), gate.indexOf("let owners"));
    expect(c).not.toContain("return true");
  });

  it("imports the trigger lazily, because the trigger imports this module", () => {
    expect(gate).toContain('await import("./sbaTrigger.js")');
    expect(signing).not.toContain('import { isSbaApplication } from "./sbaTrigger.js"');
    expect(trigger).toContain('from "./sbaSigning.js"');
  });
});

describe("the lender can tell the forms apart in the zip", () => {
  it("records what each uploaded document was", () => {
    expect(signing).toContain("docNames.push(doc.filename)");
    expect(signing).toContain("docNames?: string[]");
  });

  it("names the signed file for the form, not the SignNow id", () => {
    expect(signing).toContain("`signed-${named}`");
  });

  it("still produces a name for envelopes created before v135", () => {
    expect(signing).toContain("`sba-owner${envelope.ownerIndex}-${docId}.pdf`");
  });
});
