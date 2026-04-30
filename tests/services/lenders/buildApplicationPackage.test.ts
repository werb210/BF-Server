import { describe, it, expect } from "vitest";
import { Buffer } from "node:buffer";
import { buildApplicationPackage, type BuildPackageInput } from "../../../src/services/lenders/buildApplicationPackage";

function listZipEntries(buf: Buffer): string[] {
  const sig = Buffer.from("504B0304", "hex");
  const out: string[] = [];
  let i = 0;
  while ((i = buf.indexOf(sig, i)) !== -1) {
    const fnLen = buf.readUInt16LE(i + 26);
    const extraLen = buf.readUInt16LE(i + 28);
    const csize = buf.readUInt32LE(i + 18);
    const name = buf.slice(i + 30, i + 30 + fnLen).toString("utf8");
    out.push(name);
    i += 30 + fnLen + extraLen + csize;
  }
  return out;
}

describe("buildApplicationPackage", () => {
  it("produces a ZIP with the locked structure", async () => {
    const input: BuildPackageInput = {
      applicationId: "app-1",
      signedApplicationPdf: Buffer.from("%PDF-1.4 signed", "utf8"),
      creditSummaryPdf: Buffer.from("%PDF-1.4 credit", "utf8"),
      fields: [
        { label: "Business Name", value: "ABC Corp" },
        { label: "Annual Revenue", value: 1500000 },
        { label: "Owner Email", value: "owner@abc.com" },
      ],
      documents: [
        { category: "Bank Statements", files: [
          { filename: "jan-2026.pdf", content: Buffer.from("jan", "utf8") },
          { filename: "feb-2026.pdf", content: Buffer.from("feb", "utf8") },
        ] },
        { category: "Tax Returns", files: [{ filename: "2024.pdf", content: Buffer.from("tax", "utf8") }] },
      ],
    };

    const out = await buildApplicationPackage(input);
    expect(out.zipBuffer.length).toBeGreaterThan(0);
    expect(out.manifest.applicationId).toBe("app-1");

    const entries = listZipEntries(out.zipBuffer);
    expect(entries).toContain("signed-application.pdf");
    expect(entries).toContain("credit-summary.pdf");
    expect(entries).toContain("application-fields.json");
    expect(entries).toContain("application-fields.pdf");
    expect(entries).toContain("Bank Statements/jan-2026.pdf");
    expect(entries).toContain("Bank Statements/feb-2026.pdf");
    expect(entries).toContain("Tax Returns/2024.pdf");
  });
});
