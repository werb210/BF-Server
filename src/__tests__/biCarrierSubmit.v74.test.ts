// BF_SERVER_BI_CARRIER_v74 - accepting a term sheet fired a SignNow envelope
// and nothing else, so the PGI application never reached the carrier without
// somebody remembering to do it by hand.
import { describe, it, expect } from "vitest";
import fs from "node:fs";

const SVC = fs.readFileSync("src/services/biCarrierSubmit.ts", "utf8");
const ROUTE = fs.readFileSync("src/routes/offerAcceptance.ts", "utf8");
const MIRROR = fs.readFileSync("src/services/biDocMirror.ts", "utf8");

describe("it calls bi-server rather than reimplementing the carrier", () => {
  it("hits the endpoint that owns dispatch", () => {
    expect(SVC).toContain("/submit-pgi");
  });

  it("uses the same service-JWT pattern as the document mirror", () => {
    expect(SVC).toContain("mintServiceJwt");
    expect(MIRROR).toContain("mintServiceJwt");
    expect(SVC).toContain('scope: "bi:service"');
  });
});

describe("no PGI is not an error", () => {
  it("skips when the applicant declined at Step 6", () => {
    expect(SVC).toContain('return { ok: true, skipped: "no_pgi" }');
  });

  it("decides that from bi_public_id, which is only set when they opted in", () => {
    expect(SVC).toContain("SELECT bi_public_id FROM applications");
  });
});

describe("it cannot break an acceptance", () => {
  it("is fire and forget", () => {
    expect(ROUTE).toContain("void (async () => {");
    expect(ROUTE).toContain('console.warn("[offer] BI carrier submit failed"');
  });

  it("runs on confirmation, before the response", () => {
    const fire = ROUTE.indexOf("submitBiToCarrier");
    const respond = ROUTE.indexOf("return res.json({ ok: true, offer: row });", fire);
    expect(fire).toBeGreaterThan(-1);
    expect(respond).toBeGreaterThan(fire);
  });

  it("only fires when there is an application", () => {
    expect(ROUTE).toContain("if (row.application_id) {");
  });
});

describe("a rejection is visible", () => {
  it("logs when bi-server refuses, rather than swallowing it", () => {
    expect(SVC).toContain("bi_carrier_submit_rejected");
  });

  it("logs the success too, so the trail exists", () => {
    expect(SVC).toContain("bi_carrier_submitted");
  });

  it("times out rather than hanging the process", () => {
    expect(SVC).toContain("controller.abort()");
  });
});
