// BF_SERVER_v939_AUTO_VENDOR_INVOICE
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ read: vi.fn(), confirm: vi.fn(), load: vi.fn() }));
vi.mock("../brokerTools/invoices.js", () => ({ readInvoice: h.read, confirmInvoice: h.confirm, loadDocumentFile: h.load }));
import { autoReadVendorInvoice, isVendorInvoiceDoc } from "../brokerTools/autoInvoice.js";

function db(doc: Record<string, unknown> | null, seen = false) {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  return { calls, query: async (sql: string, params: unknown[] = []) => {
    calls.push({ sql, params });
    if (/FROM documents d/.test(sql)) return { rows: doc ? [doc] : [] };
    if (/FROM vendor_invoices/.test(sql)) return { rows: seen ? [{ x: 1 }] : [] };
    return { rows: [] };
  } };
}
const clean = { id: "inv1", read_error: null, warnings: [], data: { equipment: [{ description: "Excavator" }] } };
beforeEach(() => { h.read.mockReset(); h.confirm.mockReset(); h.load.mockReset(); h.load.mockResolvedValue({ text: "INVOICE ...", buffer: null, mimeType: null, fileName: "inv.pdf" }); });

describe("vendor invoices are read on OCR", () => {
  it("knows which documents are vendor invoices", () => {
    expect(isVendorInvoiceDoc("equipment_invoice", null)).toBe(true);
    expect(isVendorInvoiceDoc("Equipment quote / invoice of equipment", null)).toBe(true);
    expect(isVendorInvoiceDoc("purchase_order", null)).toBe(true);
    expect(isVendorInvoiceDoc("Media invoice", null)).toBe(false);
    expect(isVendorInvoiceDoc("bank_statement", null)).toBe(false);
  });

  it("confirms a clean read into the deal's equipment fields", async () => {
    h.read.mockResolvedValue(clean);
    const q = db({ category: "equipment_invoice", silo: "BF" });
    expect(await autoReadVendorInvoice(q as any, "A1", "D1")).toBe("confirmed");
    expect(h.read).toHaveBeenCalledWith(q, "A1", expect.objectContaining({ documentId: "D1", text: "INVOICE ..." }), null);
    expect(h.confirm).toHaveBeenCalledWith(q, "A1", "inv1", null);
  });

  it("leaves a read with warnings as a draft and notes it on the file", async () => {
    h.read.mockResolvedValue({ ...clean, warnings: ["Lines do not add up to the subtotal."] });
    const q = db({ category: "purchase_order", silo: "BF" });
    expect(await autoReadVendorInvoice(q as any, "A1", "D1")).toBe("draft");
    expect(h.confirm).not.toHaveBeenCalled();
    const note = q.calls.find((c) => /INSERT INTO crm_notes/.test(c.sql))!;
    expect(String(note.params[0])).toContain("Lines do not add up");
  });

  it("reads each document once and skips other documents", async () => {
    expect(await autoReadVendorInvoice(db({ category: "equipment_invoice" }, true) as any, "A1", "D1")).toBe("skipped");
    expect(await autoReadVendorInvoice(db({ category: "bank_statement" }) as any, "A1", "D1")).toBe("skipped");
    expect(h.read).not.toHaveBeenCalled();
  });

  it("never throws", async () => {
    h.read.mockRejectedValue(new Error("reader down"));
    expect(await autoReadVendorInvoice(db({ category: "equipment_invoice" }) as any, "A1", "D1")).toBe("skipped");
  });
});
