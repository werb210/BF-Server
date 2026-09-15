// BF_SERVER_AUTO_TAMPER_SCAN_v269
import { describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import { PDFDocument } from "pdf-lib";
import { scanDocumentForTampering } from "../tamperScan.js";
import { runTamperScanTick, TAMPER_BATCH } from "../../../workers/tamperScanWorker.js";

async function pdf(producer: string): Promise<Buffer> {
  const doc = await PDFDocument.create();
  doc.addPage();
  doc.setProducer(producer);
  return Buffer.from(await doc.save());
}

function fakeQuery(docRow: Record<string, unknown> | null, dupCount = "0") {
  return vi.fn(async (sql: string) => {
    if (sql.includes("FROM documents WHERE id::text")) return { rows: docRow ? [docRow] : [] };
    if (sql.includes("COUNT(DISTINCT application_id)")) return { rows: [{ n: dupCount }] };
    return { rows: [] };
  });
}
const row = { id: "d1", application_id: "a1", category: "6 months business banking statements", hash: "h1", storage_key: "k", blob_name: null, storage_path: null };

describe("scanning one document", () => {
  it("stores the level and signals it finds", async () => {
    const query = fakeQuery(row);
    const result = await scanDocumentForTampering("d1", { query, loadFile: async () => pdf("Microsoft Word") });
    expect(result?.kind).toBe("bank_statement");
    const update = query.mock.calls.find((c) => String(c[0]).startsWith("UPDATE documents SET tamper_level"));
    expect(update?.[1]?.[0]).toBe("d1");
    expect(update?.[1]?.[1]).toBe(result?.level);
  });
  it("flags the same file already used on another application", async () => {
    const query = fakeQuery(row, "2");
    const result = await scanDocumentForTampering("d1", { query, loadFile: async () => pdf("Bank Statement Generator") });
    expect(result?.duplicateCount).toBe(2);
  });
  it("marks a missing file as unavailable instead of retrying forever", async () => {
    const query = fakeQuery(row);
    expect(await scanDocumentForTampering("d1", { query, loadFile: async () => null })).toBeNull();
    const update = query.mock.calls.find((c) => String(c[0]).startsWith("UPDATE documents SET tamper_level"));
    expect(update?.[1]?.[1]).toBe("unavailable");
  });
});

describe("background worker", () => {
  it("scans a batch of unscanned recent documents and never stalls on one bad file", async () => {
    const pool = { query: vi.fn(async (sql: string) => (sql.includes("tamper_scanned_at IS NULL") ? { rows: [{ id: "bad" }, { id: "good" }] } : { rows: [] })) };
    const scan = vi.fn(async (id: string) => { if (id === "bad") throw new Error("corrupt"); return null; });
    expect(await runTamperScanTick(pool as any, scan as any)).toBe(2);
    expect(scan).toHaveBeenCalledTimes(2);
    const marked = pool.query.mock.calls.find((c) => String(c[0]).startsWith("UPDATE documents SET tamper_level"));
    expect(marked?.[1]?.slice(0, 2)).toEqual(["bad", "error"]);
    expect(pool.query.mock.calls[0][1]).toEqual([TAMPER_BATCH]);
  });
});

describe("wiring", () => {
  it("starts at boot, keeps on-demand results, and sends results to the portal", () => {
    expect(fs.readFileSync("src/index.ts", "utf8")).toContain("startTamperScanWorker(pool)");
    const portal = fs.readFileSync("src/routes/portal.ts", "utf8");
    expect(portal).toContain("await recordTamperResult(doc.id, result.level, result.signals)");
    expect(portal).toContain("tamperLevel: (classificationById.get(");
    expect(fs.readFileSync("migrations/2026_09_16_v269_document_tamper_scan.sql", "utf8")).toContain("ADD COLUMN IF NOT EXISTS tamper_scanned_at");
  });
});
