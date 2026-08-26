// BF_SERVER_ACCORD_ALL_OWNERS_v106
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const R = (...p: string[]) => readFileSync(resolve(__dirname, "..", ...p), "utf-8");
const send = R("sendApplicationForSignature.ts");
const pdf = R("pdfBuilder.ts");
const session = R("embeddedSigningSession.ts");
const accord = R("accordPdfBuilder.ts");

describe("signer roster", () => {
  it("includes additional shareholders, not just the partner", () => {
    expect(send).toContain("applicant.additionalShareholders");
  });
  it("applies the 25% threshold", () => {
    expect(send).toContain("const SIGNER_THRESHOLD = 25;");
  });
  it("the applicant always signs regardless of percentage", () => {
    expect(send).toContain("i === 0 || significant(o)");
  });
  it("unstated ownership is treated as significant", () => {
    expect(send).toContain("o.ownership === null");
  });
  it("relabels owners contiguously after filtering", () => {
    expect(send).toContain("label: `Owner ${i + 1}`");
  });
});

describe("signature fields", () => {
  it("our document emits a row per signer", () => {
    expect(pdf).toContain("for (let i = 0; i < signerOwners.length; i += 2)");
    expect(pdf).toContain("sigRow(`Owner ${i + 1}`, M)");
  });
  it("Accord's carrier form keeps its two fixed lines", () => {
    expect(accord).toContain('o:"Owner 2"');
    expect(accord).not.toContain('o:"Owner 3"');
  });
});

describe("invites", () => {
  it("every owner with an email becomes a signer", () => {
    expect(session).toContain("for (const o of rest) signers.push(");
    expect(session).toContain("roleName: `Owner ${o.index}`");
  });
  it("records the full roster for the webhook to walk", () => {
    expect(session).toContain("owner_invite_queue");
  });
  it("keeps the proven two-owner deferral path intact", () => {
    expect(session).toContain("owner2_invite_pending");
  });
});
