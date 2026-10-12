// BF_SERVER_AUTO_TAMPER_SCAN_v269
import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";
import { PDFDocument } from "pdf-lib";
import { answerBySql, callsMatching, type SqlRule } from "../../../__tests__/helpers/answerBySql.js";
import { bootIndex } from "../../../__tests__/helpers/bootIndex.js";

const h = vi.hoisted(() => ({ query: vi.fn(), file: null as Buffer | null }));
vi.mock("../../../db.js", async (orig) => {
  const real: any = await orig();
  const q = (...a: unknown[]) => h.query(...a);
  return { ...real, pool: { query: q, connect: vi.fn() }, runQuery: q, dbQuery: q };
});
vi.mock("../../../startupState.js", async (orig) => ({ ...(await orig() as any), isReady: () => true }));
vi.mock("../../../lib/storage/index.js", () => ({ getStorage: () => ({ get: async () => (h.file ? { buffer: h.file } : null) }) }));
vi.mock("../../../signnow/pnwSigning.js", async (orig) => ({ ...(await orig() as any), attachSignedPnwDocument: async () => undefined }));
vi.mock("../../../services/documents/bankStatementCoverage.js", () => ({ bankCoverageForApplication: async () => null }));
vi.mock("../../../modules/applications/applications.repo.js", async (orig) => ({
  ...(await orig() as any),
  findActiveDocumentVersion: async () => null,
  findApplicationById: async (id: string) => ({ id, name: "Acme", product_type: "term", pipeline_state: "In Review", created_at: "2026-09-01", updated_at: "2026-09-02", metadata: {} }),
  listDocumentsByApplicationId: async (id: string) => [{ id: "doc-1", application_id: id, document_type: "bank_statements", title: "Bank", created_at: "2026-09-01", status: "pending" }],
}));
import portalRouter from "../../../routes/portal.js";
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
  const app = express();
  app.use(express.json());
  app.use("/api/portal", portalRouter);
  const staff = "Bearer " + jwt.sign({ sub: "88888888-8888-4888-8888-888888888888", role: "Staff", tokenVersion: 0, tv: 0 }, process.env.JWT_SECRET as string);
  const answer = (rules: SqlRule[]) => { h.query.mockReset(); h.query.mockImplementation(answerBySql(rules)); };
  afterEach(() => { h.file = null; });

  it("starts at boot", async () => {
    const boot = await bootIndex();
    try {
      await boot.workersDone();
      expect(boot.workerCalls.get("startTamperScanWorker")).toEqual([[boot.pool]]);
    } finally { boot.restore(); }
  });

  it("keeps on-demand results: a staff fraud scan stores its level and signals", async () => {
    h.file = await pdf("Microsoft Word");
    answer([
      [/FROM documents WHERE id::text = \(\$1\)::text LIMIT 1/, { rows: [{ id: "doc-9", application_id: "app-9", filename: "s.pdf", category: "6 months business banking statements", hash: "h9", storage_key: "k9", blob_name: null, storage_path: null }] }],
      [/COUNT\(DISTINCT application_id\)/, { rows: [{ n: "0" }] }],
    ]);
    const r = await request(app).post("/api/portal/documents/doc-9/fraud-scan").set("Authorization", staff);
    expect(r.status).toBe(200);
    const stored = callsMatching(h.query, /UPDATE documents SET tamper_level = \$2/);
    expect(stored).toHaveLength(1);
    expect((stored[0][1] as unknown[]).slice(0, 2)).toEqual(["doc-9", r.body.level]);
    expect(JSON.parse(String((stored[0][1] as unknown[])[2]))).toEqual(r.body.signals);
  });

  it("sends results to the portal on the application detail", async () => {
    answer([
      [/SELECT pipeline_state, silo FROM applications/, { rows: [{ pipeline_state: "In Review", silo: "BF" }] }],
      [/tamper_level, tamper_signals/, { rows: [{ id: "doc-1", document_type: "bank_statements", category: "bank_statements", tamper_level: "high", tamper_signals: [{ code: "producer_word" }], received_in_background: false }] }],
    ]);
    const r = await request(app).get("/api/portal/applications/app-1").set("Authorization", staff);
    expect(r.status).toBe(200);
    expect(r.body.documents[0]).toMatchObject({ documentId: "doc-1", tamperLevel: "high", tamperSignals: [{ code: "producer_word" }] });
  });

  it("migration adds the scan column idempotently", () => {
    expect(fs.readFileSync("migrations/2026_09_16_v269_document_tamper_scan.sql", "utf8")).toContain("ADD COLUMN IF NOT EXISTS tamper_scanned_at");
  });
});
