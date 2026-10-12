// BF_SERVER_BLOCK_v138_E2E_FIX_BATCH_v1
// Regression guards for the v138 batch, exercised through the routes: the documents INSERT writes
// document_type from category, the dashboard / offers / submission routes are gated, and accepting an
// offer wires the pending acceptance onto the application.
import fs from "node:fs";
import path from "node:path";
import express from "express";
import jwt from "jsonwebtoken";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { answerBySql, callsMatching, sqlText } from "./helpers/answerBySql.js";

const h = vi.hoisted(() => ({ queryMock: vi.fn() }));
vi.mock("../db.js", async () => {
  const actual = await vi.importActual<typeof import("../db.js")>("../db.js");
  const pool = { query: h.queryMock, connect: async () => ({ query: h.queryMock, release: () => undefined }) };
  return { ...actual, pool, dbQuery: h.queryMock, runQuery: h.queryMock, db: pool };
});
vi.mock("../lib/storage/index.js", () => ({
  getStorage: () => ({ put: async () => ({ hash: "hash-1", blobName: "blob-1", url: "https://blob/1", sizeBytes: 10 }) }),
}));
vi.mock("../modules/ocr/ocr.service.js", () => ({ enqueueOcrForDocument: async () => undefined }));
vi.mock("../services/biDocMirror.js", () => ({ mirrorDocToBiAsync: () => undefined, withdrawDocFromBiAsync: () => undefined }));
vi.mock("../modules/automation/automationEngine.js", () => ({ emitAutomationEvent: async () => undefined }));
vi.mock("../routes/clientDocumentsNeeded.js", () => ({ computeOutstandingDocs: async () => ({ required: [], stillNeeded: [], rejected: [] }) }));

import { persistAndEnqueue } from "../routes/documents.js";
import dashboardRouter from "../routes/dashboard.js";
import offersRouter from "../routes/offers.js";
import offerAcceptanceRouter from "../routes/offerAcceptance.js";
import submissionOrchestrationRouter from "../routes/submissionOrchestration.js";

const repoRoot = path.resolve(__dirname, "..", "..");
const read = (rel: string) => fs.readFileSync(path.join(repoRoot, rel), "utf-8");

const APP_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OFFER_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const sign = (role: string) => "Bearer " + jwt.sign({ sub: "11111111-1111-4111-8111-111111111111", role, tokenVersion: 0, tv: 0 }, process.env.JWT_SECRET as string, { algorithm: "HS256" });

const app = express();
app.use(express.json());
app.use("/api/dashboard", dashboardRouter);
app.use("/api/offers", offersRouter);
app.use("/api/offers", offerAcceptanceRouter);
app.use("/api", submissionOrchestrationRouter);

/** The column -> VALUES expression mapping of an INSERT statement as it was sent to the database. */
function insertMapping(sql: string): Record<string, string> {
  const m = sql.match(/INSERT INTO \w+\s*\(([^)]*)\)\s*VALUES\s*\(([\s\S]*)\)\s*$/);
  if (!m) throw new Error("not an INSERT: " + sql);
  const cols = m[1].split(",").map((s) => s.trim());
  const vals = m[2].replace(/\bnow\(\)/g, "now").split(",").map((s) => s.trim());
  expect(vals.length).toBe(cols.length);
  return Object.fromEntries(cols.map((c, i) => [c, vals[i]]));
}

beforeEach(() => {
  h.queryMock.mockReset();
  h.queryMock.mockImplementation(answerBySql([]));
});

describe("v138 E2E fix batch", () => {
  it("AUDIT-19: documents.ts INSERT writes document_type from category", async () => {
    h.queryMock.mockImplementation(answerBySql([
      [/WITH root AS/, { rows: [{ id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", is_companion: true }] }],
    ]));
    const file = { buffer: Buffer.from("%PDF"), originalname: "s.pdf", mimetype: "application/pdf" } as Express.Multer.File;
    await persistAndEnqueue({ applicationId: APP_ID, category: "A/R", file });
    const inserts = callsMatching(h.queryMock, /INSERT INTO documents/);
    // The upload itself, then the copy shared to the linked companion leg.
    expect(inserts).toHaveLength(2);
    for (const [sql, params] of inserts) {
      const map = insertMapping(sqlText(sql));
      expect(map.document_type).toBe("$5");
      expect(map.category).toBe("$5");
      expect((params as unknown[])[4]).toBe("A/R");
      expect(map.status).toBe("'uploaded'");
      expect(map.created_at).toBe("now");
      expect(map.updated_at).toBe("now");
    }
    const shared = insertMapping(sqlText(inserts[1][0]));
    expect(shared.ocr_status).toBe("'pending'");
    expect(shared.uploaded_by).toBe("$10");
  });

  it("AUDIT-19: backfill migration shipped", () => {
    const sql = read("migrations/2026_05_05_documents_document_type_backfill.sql");
    expect(sql).toContain("BF_SERVER_BLOCK_v138_E2E_FIX_BATCH_v1");
    expect(sql).toContain("UPDATE documents");
    expect(sql).toContain("SET document_type = category");
  });

  it("AUDIT-10: dashboard.ts /actions and /pipeline are gated", async () => {
    for (const p of ["/api/dashboard/actions", "/api/dashboard/pipeline"]) {
      const anon = await request(app).get(p);
      expect(anon.status, p).toBe(401);
      const staff = await request(app).get(p).set("Authorization", sign("Staff"));
      expect(staff.status, p).not.toBe(401);
      expect(staff.status, p).not.toBe(403);
    }
  });

  it("AUDIT-11: offers.ts (3 routes) are gated", async () => {
    const routes: Array<() => request.Test> = [
      () => request(app).get("/api/offers").query({ applicationId: APP_ID }),
      () => request(app).post("/api/offers").send({ applicationId: APP_ID }),
      () => request(app).patch(`/api/offers/${OFFER_ID}/status`).send({ status: "accepted" }),
    ];
    for (const r of routes) {
      expect((await r()).status).toBe(401);
      expect((await r().set("Authorization", sign("Lender"))).status).toBe(403);
      const staff = await r().set("Authorization", sign("Staff"));
      expect([401, 403]).not.toContain(staff.status);
    }
  });

  it("AUDIT-12: submissionOrchestration.ts (2 routes) are gated", async () => {
    for (const p of [`/api/applications/${APP_ID}/lenders/send`, `/api/applications/${APP_ID}/submit-trigger-check`]) {
      expect((await request(app).post(p).send({})).status, p).toBe(401);
      expect((await request(app).post(p).set("Authorization", sign("Lender")).send({})).status, p).toBe(403);
      expect((await request(app).post(p).set("Authorization", sign("Ops")).send({})).status, p).toBe(403);
    }
  });

  it("AUDIT-13 + AUDIT-17: offerAcceptance.ts /confirm-acceptance gated, /accept wires in", async () => {
    const confirm = `/api/offers/${OFFER_ID}/confirm-acceptance`;
    expect((await request(app).post(confirm).send({})).status).toBe(401);
    expect((await request(app).post(confirm).set("Authorization", sign("Lender")).send({})).status).toBe(403);

    h.queryMock.mockImplementation(answerBySql([
      [/UPDATE offers\s+SET status = 'pending_acceptance'/, { rows: [{ id: OFFER_ID, status: "pending_acceptance", application_id: APP_ID }] }],
    ]));
    const r = await request(app).post(`/api/offers/${OFFER_ID}/accept`).set("Authorization", sign("Staff")).send({});
    expect(r.status).toBe(200);
    expect(r.body.offer).toMatchObject({ id: OFFER_ID, status: "pending_acceptance" });
    const wire = callsMatching(h.queryMock, /UPDATE applications/);
    expect(wire).toHaveLength(1);
    expect(sqlText(wire[0][0])).toContain("pending_acceptance_offer_id = $1::uuid");
    expect(sqlText(wire[0][0])).toContain("pending_acceptance_at = NOW()");
    expect(wire[0][1]).toEqual([OFFER_ID, APP_ID]);

    expect((await request(app).post(`/api/offers/${OFFER_ID}/accept`).send({})).status).toBe(401);
  });
});
