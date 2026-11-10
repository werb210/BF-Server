// BF_SERVER_v936_CLIENT_OFFER_CLEANUP
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ blobs: new Map<string, { buffer: Buffer; contentType: string }>(), sql: [] as Array<{ sql: string; params: unknown[] }>, offer: { blob: "b1", filename: "Term Sheet.docx", lender: "Bondit Media" } as any }));
vi.mock("../db.js", async (orig) => {
  const real: any = await orig();
  const runQuery = async (sql: string, params: unknown[] = []) => {
    h.sql.push({ sql, params });
    if (/from offers where id::text = \$1/i.test(sql) && /term_sheet_blob_name/i.test(sql)) return { rows: h.offer ? [h.offer] : [] };
    if (/^\s*update offers set/i.test(sql)) return { rows: [{ amount: "1040000" }] };
    return { rows: [] };
  };
  return { ...real, runQuery, pool: { query: runQuery } };
});
vi.mock("../lib/storage/index.js", () => ({ getStorage: () => ({ get: async (k: string) => h.blobs.get(k) ?? null }) }));
vi.mock("../brokerTools/offerReader.js", () => ({
  readOfferDocument: async () => ({ offer: { amount: 1040000, rate_kind: "interest_rate", rate: 12.5, term_months: 18, payment_frequency: "monthly", expiry_date: "2026-11-30", conditions: [], fees: [] }, textChars: 100 }),
}));

async function docx(text: string): Promise<Buffer> {
  const { default: JSZip } = await import("jszip");
  const zip = new JSZip();
  zip.file("[Content_Types].xml", '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
  zip.file("_rels/.rels", '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  zip.file("word/document.xml", `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`);
  return zip.generateAsync({ type: "nodebuffer" });
}

beforeEach(() => { h.blobs.clear(); h.sql.length = 0; process.env.JWT_SECRET = "test-secret-1234567890"; });

describe("term sheet viewing", () => {
  it("shows a Word term sheet as a readable page", async () => {
    h.blobs.set("b1", { buffer: await docx("Commitment Amount 1,040,000"), contentType: "application/octet-stream" });
    const { termSheetForViewing } = await import("../brokerTools/termSheetView.js");
    const v = await termSheetForViewing("o1");
    expect(v.ok).toBe(true);
    if (v.ok) { expect(v.contentType).toMatch(/text\/html/); expect(v.body.toString()).toContain("Commitment Amount 1,040,000"); expect(v.body.toString()).toContain("Bondit Media"); }
  });
  it("passes a PDF through unchanged", async () => {
    h.blobs.set("b1", { buffer: Buffer.from("%PDF-1.4 x"), contentType: "application/pdf" });
    const { termSheetForViewing } = await import("../brokerTools/termSheetView.js");
    const v = await termSheetForViewing("o1");
    expect(v.ok && v.contentType).toBe("application/pdf");
  });
  it("view links are signed and expire", async () => {
    const { termSheetViewToken, offerIdFromViewToken } = await import("../brokerTools/termSheetView.js");
    expect(offerIdFromViewToken(termSheetViewToken("o-123"))).toBe("o-123");
    expect(offerIdFromViewToken("not-a-token")).toBeNull();
  });
});

describe("offer filled from the term sheet", () => {
  it("fills only empty fields, never what staff typed", async () => {
    h.blobs.set("b1", { buffer: await docx("x"), contentType: "application/octet-stream" });
    const { fillOfferFromTermSheet } = await import("../brokerTools/termSheetView.js");
    const r = await fillOfferFromTermSheet("o1");
    expect(r.filled).toEqual(expect.arrayContaining(["amount", "rate", "term", "payment_frequency", "expiry_date"]));
    const upd = h.sql.find((q) => /^\s*update offers set/i.test(q.sql))!;
    expect(upd.sql).toMatch(/amount = coalesce\(amount/);
    expect(upd.params).toEqual(["o1", 1040000, "12.5%", "18 months", "monthly", "2026-11-30"]);
  });
  it("never throws when there is no term sheet", async () => {
    h.offer = null;
    const { fillOfferFromTermSheet } = await import("../brokerTools/termSheetView.js");
    await expect(fillOfferFromTermSheet("missing")).resolves.toEqual({ filled: [] });
    h.offer = { blob: "b1", filename: "Term Sheet.docx", lender: "Bondit Media" };
  });
});
