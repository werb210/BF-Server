// BF_SERVER_BLOCK_v_ACCORD_PACKAGE_ROOT_v1 — locks the requirement that signed
// supplemental forms (the Accord credit application) ship at the package ROOT,
// exactly like signed-application.pdf, not nested in a category subfolder.
import { describe, it, expect } from "vitest";
import { Buffer } from "node:buffer";
import { buildApplicationPackage } from "../buildApplicationPackage.js";

describe("buildApplicationPackage — supplemental signed forms at root", () => {
  it("attaches additionalSignedDocs at the package root, like signed-application.pdf", async () => {
    const out = await buildApplicationPackage({
      applicationId: "app-1",
      signedApplicationPdf: Buffer.from("%PDF-1.4 signed"),
      creditSummaryPdf: null,
      fields: [{ label: "Business Name", value: "Acme LLC" }],
      documents: [
        { category: "6 months business banking statements", files: [{ filename: "jan.pdf", content: Buffer.from("doc") }] },
      ],
      additionalSignedDocs: [
        { filename: "accord-credit-application-app-1.pdf", content: Buffer.from("%PDF-1.4 accord") },
      ],
    });
    const entries = out.manifest.entries;
    expect(entries).toContain("signed-application.pdf");
    expect(entries).toContain("accord-credit-application-app-1.pdf");
    expect(entries.some((e) => e.startsWith("6 months business banking statements/"))).toBe(true);
    expect(entries.some((e) => e.includes("/accord-credit-application-app-1.pdf"))).toBe(false);
  });

  it("is a no-op when no supplemental signed docs are present", async () => {
    const out = await buildApplicationPackage({
      applicationId: "app-2",
      signedApplicationPdf: Buffer.from("%PDF-1.4 signed"),
      creditSummaryPdf: null,
      fields: [],
      documents: [],
      additionalSignedDocs: [],
    });
    expect(out.manifest.entries).toContain("signed-application.pdf");
    expect(out.manifest.entries.some((e) => e.endsWith(".pdf") && e !== "signed-application.pdf" && e !== "application-fields.pdf")).toBe(false);
  });
});
