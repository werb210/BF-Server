// BF_SERVER_DOCUMENT_DUPLICATE_GUARD_v256
import { describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import { assertNotDuplicate, duplicateGroupsForApplication, DuplicateDocumentError, fingerprint } from "../duplicateDocuments.js";

const APP = "467689d3-2008-42a6-87d3-720919c6e5b9";
const balanceSheet = Buffer.from("%PDF-1.4 Voss Events Balance Sheet 4.30.26");

describe("upload guard", () => {
  it("lets a new file through and returns its fingerprint", async () => {
    const query = vi.fn(async () => ({ rows: [] }));
    expect(await assertNotDuplicate(APP, balanceSheet, query)).toBe(fingerprint(balanceSheet));
    expect((query.mock.calls[0] as any)[1]).toEqual([APP, fingerprint(balanceSheet)]);
  });
  it("refuses the same file on the same application, naming where it already is", async () => {
    const existing = { id: "d1", category: "Balance Sheet - Interim financials", filename: "Voss Events Balance Sheet - 4.30.26 (1).pdf", status: "uploaded" };
    const query = vi.fn(async () => ({ rows: [existing] }));
    const err = await assertNotDuplicate(APP, balanceSheet, query).catch((e) => e);
    expect(err).toBeInstanceOf(DuplicateDocumentError);
    expect(err.name).toBe("DuplicateDocumentError");
    expect(err.existing).toEqual(existing);
    expect(err.message).toBe("This file is already uploaded on this application under Balance Sheet - Interim financials.");
  });
  it("identical bytes always share a fingerprint and different bytes never do", () => {
    expect(fingerprint(Buffer.from("a"))).toBe(fingerprint(Buffer.from("a")));
    expect(fingerprint(Buffer.from("a"))).not.toBe(fingerprint(Buffer.from("b")));
  });
});

describe("existing duplicates", () => {
  it("groups copies behind the oldest upload", async () => {
    const docs = [
      { id: "d1", category: "Balance Sheet - Interim financials", filename: "BS.pdf", status: "uploaded", created_at: "2026-09-11T10:00:00Z" },
      { id: "d2", category: "A/P", filename: "BS.pdf", status: "uploaded", created_at: "2026-09-11T10:01:00Z" },
      { id: "d3", category: "other", filename: "BS.pdf", status: "uploaded", created_at: "2026-09-11T10:02:00Z" },
    ];
    const query = vi.fn(async () => ({ rows: [{ hash: "h1", docs }] }));
    const groups = await duplicateGroupsForApplication(APP, query);
    expect(groups).toEqual([{ hash: "h1", original: docs[0], copies: [docs[1], docs[2]] }]);
    expect(String((query.mock.calls[0] as any)[0])).toContain("HAVING COUNT(*) > 1");
  });
});

describe("wiring", () => {
  const documents = fs.readFileSync("src/routes/documents.ts", "utf8");
  it("checks before anything is written to storage", () => {
    const fn = documents.slice(documents.indexOf("export async function persistAndEnqueue"));
    expect(fn.indexOf("await assertNotDuplicate(opts.applicationId, opts.file.buffer)")).toBeGreaterThan(-1);
    expect(fn.indexOf("await assertNotDuplicate(")).toBeLessThan(fn.indexOf("store.put("));
  });
  it("answers 409 with the existing document on every upload route", () => {
    expect(documents.match(/instanceof DuplicateDocumentError\) return res\.status\(409\)/g)?.length).toBe(2);
    expect(fs.readFileSync("src/routes/accountant.ts", "utf8")).toContain('err?.name === "DuplicateDocumentError"');
    expect(documents).toContain('\"/:applicationId/duplicates\"');
  });
});
