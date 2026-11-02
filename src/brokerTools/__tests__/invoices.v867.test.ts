// BF_SERVER_v867_BROKER_TOOLS_INVOICES - reading, checking and confirming vendor invoices (database faked by SQL content).
import { afterEach, describe, expect, it } from "vitest";
import {
  checkInvoice, confirmInvoice, invoiceDate, metadataPatch, normaliseInvoice, parseReaderJson, readInvoice, setInvoiceReader, vinCheck,
} from "../invoices.js";

const SAMPLE = {
  vendor: { name: "Prairie Equipment Ltd.", tax_number: "123456789RT0001" }, invoice_number: "INV-2041", invoice_date: "Oct 3, 2026",
  line_items: [{ description: "2024 Kubota KX040 excavator", quantity: 1, unit_price: "$85,000.00", amount: "85,000.00", vin: "" },
    { description: "Freight", amount: 1500 }],
  subtotal: "86,500.00", taxes: [{ label: "GST 5%", amount: "4,325.00" }], total: "$90,825.00",
  equipment: [{ description: "2024 Kubota KX040 excavator", year: "2024", make: "Kubota", model: "KX040", serial_number: " kx040-55123 ", condition: "new", cost: 85000 }],
};

afterEach(() => setInvoiceReader(null));

describe("vendor invoices", () => {
  it("reads printed dates and refuses ambiguous ones", () => {
    expect(invoiceDate("Oct 3, 2026")).toBe("2026-10-03");
    expect(invoiceDate("3 October 2026")).toBe("2026-10-03");
    expect(invoiceDate("2026-10-03")).toBe("2026-10-03");
    expect(invoiceDate("25/10/2026")).toBe("2026-10-25");
    expect(invoiceDate("03/04/2026")).toBeNull();
    expect(invoiceDate("Feb 30, 2026")).toBeNull();
  });

  it("checks VINs, including the check digit", () => {
    expect(vinCheck("1M8GDM9AXKP042788")).toEqual({ valid: true, checkDigit: true });
    expect(vinCheck("1M8GDM9A1KP042788")).toEqual({ valid: true, checkDigit: false });
    expect(vinCheck("1M8GDM9AXKP04278O").valid).toBe(false);
  });

  it("normalises money, serials and equipment", () => {
    const d = normaliseInvoice(SAMPLE);
    expect(d).toMatchObject({ vendor_name: "Prairie Equipment Ltd.", invoice_number: "INV-2041", invoice_date: "2026-10-03", subtotal: 86500, total: 90825, currency: "CAD" });
    expect(d.line_items[0]).toMatchObject({ unit_price: 85000, amount: 85000, vin: null });
    expect(d.equipment[0]).toMatchObject({ year: 2024, serial_number: "KX040-55123", cost: 85000, condition: "new" });
  });

  it("flags totals that do not add up, the wrong province rate and missing serials", () => {
    expect(checkInvoice(normaliseInvoice(SAMPLE), 5)).toEqual([]);
    const off = normaliseInvoice({ ...SAMPLE, total: 91000, equipment: [{ description: "Bucket" }] });
    const w = checkInvoice(off, 13);
    expect(w.some((x) => x.includes("is not the total"))).toBe(true);
    expect(w.some((x) => x.includes("province is 13%"))).toBe(true);
    expect(w.some((x) => x.includes("no serial number or VIN"))).toBe(true);
  });

  it("parses the reader's JSON even inside a code fence", () => {
    expect(parseReaderJson('```json\n{"invoice_number":"A1"}\n```')).toEqual({ invoice_number: "A1" });
    expect(() => parseReaderJson("sorry")).toThrow();
  });

  it("fills the equipment amount only when the file has none, and replaces the same invoice", () => {
    const d = normaliseInvoice(SAMPLE);
    expect(metadataPatch({}, { id: "i1", data: d })).toMatchObject({ equipment_amount: 86500, equipment_vendor: "Prairie Equipment Ltd." });
    const p = metadataPatch({ equipment_amount: 90000, equipment_invoices: [{ invoice_id: "i1" }, { invoice_id: "i0" }] }, { id: "i1", data: d });
    expect(p.equipment_amount).toBeUndefined();
    expect((p.equipment_invoices as any[]).map((x) => x.invoice_id)).toEqual(["i0", "i1"]);
  });

  it("reads into a draft, then confirming fills the deal and the contract's assets once", async () => {
    const calls: { sql: string; params: unknown[] }[] = [];
    let stored: Record<string, any> | null = null;
    const assets: any[] = [{ description: "Old loader", serial_number: "LDR-1", cost: 1 }];
    const q = {
      query: async (sql: string, params: unknown[] = []) => {
        calls.push({ sql, params });
        if (/FROM applications a/.test(sql) || /SELECT .*province/i.test(sql)) return { rows: [] };
        if (/INSERT INTO vendor_invoices/.test(sql)) {
          stored = { id: "11111111-1111-4111-8111-111111111111", application_id: params[0], document_id: params[1], file_name: params[2], status: "draft", source: "ai",
            data: JSON.parse(String(params[3])), warnings: JSON.parse(String(params[4])), model: params[6], read_error: params[7], created_at: new Date() };
          return { rows: [stored] };
        }
        if (/FROM vendor_invoices WHERE application_id = \$1 AND id/.test(sql)) return { rows: stored ? [stored] : [] };
        if (/SELECT metadata FROM applications/.test(sql)) return { rows: [{ metadata: { equipment_amount: 0 } }] };
        if (/UPDATE applications SET metadata/.test(sql)) return { rows: [], rowCount: 1 };
        if (/UPDATE vendor_invoices SET status = 'confirmed'/.test(sql)) { stored = { ...stored!, status: "confirmed", confirmed_at: new Date() }; return { rows: [] }; }
        if (/to_regclass/.test(sql)) return { rows: [{ ok: true }] };
        if (/FROM active_contracts WHERE application_id/.test(sql)) return { rows: [{ id: "22222222-2222-4222-8222-222222222222" }] };
        if (/FROM active_contract_assets WHERE contract_id/.test(sql)) return { rows: assets };
        if (/INSERT INTO active_contract_assets/.test(sql)) { assets.push({ description: params[1], serial_number: params[5], cost: params[7] }); return { rows: [] }; }
        if (/UPDATE vendor_invoices SET assets_contract_id/.test(sql)) { stored = { ...stored!, assets_contract_id: params[1] }; return { rows: [] }; }
        if (/sales_tax_rates/.test(sql)) return { rows: [] };
        throw new Error("unexpected SQL: " + sql.slice(0, 80));
      },
    };
    setInvoiceReader(async () => ({ raw: SAMPLE, model: "test" }));
    const draft = await readInvoice(q, "app-1", { text: "x".repeat(50), documentId: "doc-1", fileName: "inv.pdf" }, null);
    expect(draft).toMatchObject({ status: "draft", document_id: "doc-1", model: "test" });
    expect(draft.data.total).toBe(90825);
    const done = await confirmInvoice(q, "app-1", draft.id, null);
    expect(done.status).toBe("confirmed");
    expect(done.assets_contract_id).toBe("22222222-2222-4222-8222-222222222222");
    expect(assets.map((a) => a.serial_number)).toEqual(["LDR-1", "KX040-55123"]);
    const md = calls.find((c) => /UPDATE applications SET metadata/.test(c.sql))!;
    expect(JSON.parse(String(md.params[1]))).toMatchObject({ equipment_amount: 86500 });
    await expect(confirmInvoice(q, "app-1", draft.id, null)).rejects.toThrow("Only a draft");
  });

  it("keeps a failed reading as an empty draft staff can fill in", async () => {
    setInvoiceReader(async () => { throw new Error("timeout"); });
    const q = { query: async (sql: string, params: unknown[] = []) => {
      if (/INSERT INTO vendor_invoices/.test(sql)) return { rows: [{ id: "x", application_id: params[0], status: "draft", data: JSON.parse(String(params[3])), warnings: [], read_error: params[7], created_at: new Date() }] };
      return { rows: [] };
    } };
    const d = await readInvoice(q, "app-1", { text: "y".repeat(50) }, null);
    expect(d.read_error).toBe("timeout");
    expect(d.data.equipment).toEqual([]);
  });
});
