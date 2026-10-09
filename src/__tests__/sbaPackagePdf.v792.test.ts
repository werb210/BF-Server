// BF_SERVER_SBA_PACKAGE_PDF_v792
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const loader = readFileSync("src/services/lenders/loadPackageInputs.ts", "utf8");
const portal = readFileSync("src/routes/portal.ts", "utf8");
const fn = loader.slice(loader.indexOf("async function loadSignedApplicationPdf"), loader.indexOf("// Never fabricate"));

describe("the signed application reaches the lender package", () => {
  it("reads the cached signed copy from the signed-applications container first", () => {
    expect(fn.indexOf("downloadBlobAsset(blobName)")).toBeGreaterThan(0);
    expect(fn.indexOf("downloadBlobAsset(blobName)")).toBeLessThan(fn.indexOf("getStorage().get(blobName)"));
  });
  it("an SBA file can re-download owner 1's signed application from SignNow", () => {
    expect(fn).toContain("e->>'applicationDocId'");
    expect(fn).toContain("(e->>'ownerIndex') = '1'");
  });
  it("Documents can open the filed signed application", () => {
    const route = portal.slice(portal.indexOf('"/documents/:id/file"'));
    expect(route.indexOf("downloadBlobAsset(storageKey)")).toBeGreaterThan(0);
    expect(route.indexOf("downloadBlobAsset(storageKey)")).toBeLessThan(route.indexOf('"Document file not available."', route.indexOf("downloadBlobAsset")));
  });
});
