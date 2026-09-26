// BF_SERVER_v76_BLOCK_1_9 / BF_SERVER_BLOCK_v580
// The package must never carry an application "signed" PDF built from form data: with no real
// signed document on file it is null (the package build then hard-fails), and when the signed
// PDF is stored it is that exact file that goes out.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Buffer } from "node:buffer";
const storeGet = vi.fn();
vi.mock("../../../src/lib/storage/index.js", () => ({ getStorage: () => ({ get: storeGet, put: vi.fn(), delete: vi.fn(), ping: vi.fn(), describe: () => ({ kind: "local" as const }) }) }));
import { loadPackageInputs } from "../../../src/services/lenders/loadPackageInputs";
function fakePool(handler: (sql: string, args: unknown[]) => unknown[]): any { return { query: vi.fn(async (sql: string, args: unknown[] = []) => ({ rows: handler(sql, args) })) }; }
const APP = { name: "Acme", requested_amount: 1, product_category: null, product_type: null, metadata: { business: { name: "Acme" } } };
beforeEach(() => { storeGet.mockReset(); });

describe("loadPackageInputs", () => {
  it("never fabricates a signed application when none is on file", async () => {
    const pool = fakePool((sql) => {
      if (sql.includes("metadata, name")) return [APP];
      if (sql.includes("signnow_document_id")) return [{ signnow_document_id: null, signed_application_blob_name: null, signed_at: null }];
      return [];
    });
    const out = await loadPackageInputs({ pool, applicationId: "app-1" });
    expect(out.fields.length).toBeGreaterThan(0);
    expect(out.signedApplicationPdf).toBeNull();
  });

  it("uses the stored signed PDF when there is one", async () => {
    const signed = Buffer.from("%PDF-1.7 signed");
    storeGet.mockResolvedValue({ buffer: signed });
    const pool = fakePool((sql) => {
      if (sql.includes("metadata, name")) return [APP];
      if (sql.includes("signnow_document_id")) return [{ signnow_document_id: "g1", signed_application_blob_name: "applications/app-1/signed.pdf", signed_at: "2026-09-01T00:00:00Z" }];
      return [];
    });
    const out = await loadPackageInputs({ pool, applicationId: "app-1" });
    expect(storeGet).toHaveBeenCalledWith("applications/app-1/signed.pdf");
    expect(out.signedApplicationPdf?.toString("latin1")).toBe("%PDF-1.7 signed");
  });
});
