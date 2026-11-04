// BF_SERVER_v886_OCR_SIGNS_AND_KINDS + BF_SERVER_v886_OCR_REEXTRACT - a made-up balance sheet and P&L laid out like the
// QuickBooks exports in the Nov 2026 portal review (no client data).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { extractOcrFields, statementKind, withStatementSign } from "../ocr.service.js";
import { modelFieldsFrom, reextractDocument } from "../reextract.js";

const docs = JSON.parse(readFileSync(join(__dirname, "fixtures.v886.sample.json"), "utf8"));
const asMap = (rows: Array<{ fieldKey: string; value: string }>) => Object.fromEntries(rows.map((r) => [r.fieldKey, r.value]));

describe("statement signs and kinds", () => {
  it("balance sheet: negative liabilities stay negative and the sheet balances", () => {
    const f = asMap(extractOcrFields(docs.bs[0], docs.bs[1]));
    expect(f.total_liabilities).toBe("-700000");
    expect(f.credit_cards).toBe("-15000");
    expect(f.current_assets).toBe("250000");
    expect(Number(f.total_liabilities) + Number(f.total_equity)).toBeCloseTo(Number(f.total_assets), 2);
  });
  it("P&L: no balance-sheet fields and no label fragments", () => {
    const f = asMap(extractOcrFields(docs.pl[0], docs.pl[1]));
    expect(f.equipment_value).toBeUndefined();
    expect(f.payroll_liability).toBeUndefined();
    expect(f.sin).toBeUndefined();
    expect(f.subcontractor).toBeUndefined();
    expect(f.total_revenue).toBe("1000000");
  });
  it("kinds and signs on their own", () => {
    expect(statementKind("Profit and Loss\nJanuary-July")).toBe("income_statement");
    expect(statementKind("Balance Sheet\nAs of Jul 31")).toBe("balance_sheet");
    expect(statementKind("Bank statement")).toBeNull();
    expect(withStatementSign({ fieldKey: "total_liabilities", value: "500" }, "Total Liabilities (500.00)").value).toBe("-500");
    expect(withStatementSign({ fieldKey: "total_liabilities", value: "500" }, "Total Liabilities $500.00 and -$500.00").value).toBe("500");
    expect(withStatementSign({ fieldKey: "business_name", value: "5" }, "-$5.00").value).toBe("5");
  });
});

describe("re-reading a stored document", () => {
  it("replaces that document's rows in one transaction", async () => {
    const calls: Array<[string, unknown[]]> = [];
    const client = { query: vi.fn(async (sql: string, p: unknown[] = []) => { calls.push([sql.trim(), p]); return { rows: [] }; }), release: vi.fn() };
    const db = {
      connect: async () => client as any,
      query: vi.fn(async (sql: string) => /FROM ocr_document_results/.test(sql)
        ? { rows: [{ extracted_text: docs.bs[0], extracted_json: { fields: docs.bs[1] }, application_id: "app1", document_type: "balance_sheet" }] }
        : { rows: [] }),
    };
    const n = await reextractDocument(db as any, "doc1");
    expect(n).toBeGreaterThan(5);
    const sqls = calls.map(([s]) => s.split(/\s+/).slice(0, 3).join(" "));
    expect(sqls[0]).toBe("BEGIN");
    expect(sqls[1]).toBe("DELETE FROM ocr_results");
    expect(sqls.at(-1)).toBe("COMMIT");
    expect(calls.filter(([s]) => /^INSERT INTO ocr_results/.test(s)).length).toBe(n);
    expect(client.release).toHaveBeenCalled();
  });
  it("reads model fields as the worker does", () => {
    expect(modelFieldsFrom({ fields: { a: "$1", b: 2, c: " ", d: null } })).toEqual({ a: "$1", b: 2 });
    expect(modelFieldsFrom(null)).toEqual({});
  });
});
