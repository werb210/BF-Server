// BF_SERVER_BACKGROUND_UPLOAD_v306
import { beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import express from "express";
import jwt from "jsonwebtoken";
import request from "supertest";
import { answerBySql, callsMatching, sqlText } from "../../__tests__/helpers/answerBySql.js";

const h = vi.hoisted(() => ({ queryMock: vi.fn() }));
vi.mock("../../db", async () => {
  const actual = await vi.importActual<typeof import("../../db.js")>("../../db");
  return {
    ...actual,
    pool: { query: h.queryMock, connect: vi.fn(async () => ({ query: h.queryMock, release: vi.fn() })) },
    runQuery: h.queryMock, dbQuery: h.queryMock, query: h.queryMock,
  };
});
vi.mock("../../lib/storage/index.js", () => ({
  getStorage: () => ({ put: vi.fn(async () => ({ blobName: "applications/a/file.pdf", url: "https://blob/file.pdf", sizeBytes: 4, hash: "h1" })) }),
}));
vi.mock("../../modules/ocr/ocr.service.js", async (orig) => ({
  ...(await orig<typeof import("../../modules/ocr/ocr.service.js")>()),
  enqueueOcrForDocument: vi.fn(async () => undefined),
}));
vi.mock("../../services/biDocMirror.js", () => ({ mirrorDocToBiAsync: vi.fn(), withdrawDocFromBiAsync: vi.fn() }));

const migration = fs.readFileSync("migrations/2026_09_16_v306_documents_received_in_background.sql", "utf8");
const APP_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const staffToken = () => jwt.sign({ sub: "00000000-0000-4000-8000-0000000000b1", role: "Staff", tokenVersion: 0, tv: 0 }, process.env.JWT_SECRET as string);

async function mount(path: string, modPath: string) {
  const router = (await import(modPath)).default;
  const { errorHandler } = await import("../../middleware/errors.js");
  const app = express();
  app.use(express.json());
  app.use(path, router);
  app.use(errorHandler);
  return app;
}

const insertedFlag = () => {
  const [sql, params] = callsMatching(h.queryMock, /INSERT INTO documents/)[0]!;
  expect(sqlText(sql)).toContain("offer_id, received_in_background, created_at, updated_at)");
  expect(sqlText(sql)).toContain("$12,$13,now(),now())");
  return (params as unknown[])[12];
};

beforeEach(() => {
  h.queryMock.mockReset();
  h.queryMock.mockImplementation(answerBySql([
    [/FROM application_continuations/, { rows: [{ ok: 1 }] }],
    [/SELECT pipeline_state FROM applications/, { rows: [{ pipeline_state: "Documents Required" }] }],
  ]));
});

describe("background upload flag", () => {
  describe("both upload routes read the header the phone sends and store it on the document", () => {
    const upload = async (path: string, background: boolean, auth: (r: request.Test) => request.Test) => {
      const app = await mount("/api/documents", "../documents.js");
      let req = request(app).post(path);
      req = auth(req);
      if (background) req = req.set("x-background-upload", "1");
      return req.field("applicationId", APP_ID).field("category", "VOID cheque or PAD").attach("file", Buffer.from("%PDF"), { filename: "cheque.pdf", contentType: "application/pdf" });
    };

    it("/upload", async () => {
      const res = await upload("/api/documents/upload", true, (r) => r.set("Authorization", `Bearer ${staffToken()}`));
      expect(res.status).toBe(200);
      expect(insertedFlag()).toBe(true);
    });

    it("/upload without the header stores false", async () => {
      const res = await upload("/api/documents/upload", false, (r) => r.set("Authorization", `Bearer ${staffToken()}`));
      expect(res.status).toBe(200);
      expect(insertedFlag()).toBe(false);
    });

    it("/public-upload", async () => {
      const res = await upload("/api/documents/public-upload", true, (r) => r.set("X-Continuation-Token", "cont-token-1"));
      expect(res.status).toBe(200);
      expect(insertedFlag()).toBe(true);
    });
  });

  it("returns it on the Documents tab, for the application's own files and a parent's", async () => {
    const file = (id: string, bg: boolean | null) => ({ id, filename: `${id}.pdf`, size_bytes: 1, created_at: "2026-10-01T00:00:00Z", status: "uploaded", category: "Void cheque", ocr_status: null, received_in_background: bg });
    h.queryMock.mockImplementation(answerBySql([
      [/SELECT id, silo, requested_amount, metadata, parent_application_id, source FROM applications/, { rows: [{ id: APP_ID, silo: "BF", requested_amount: null, metadata: {}, parent_application_id: "pppppppp-pppp-4ppp-8ppp-pppppppppppp", source: "capital_and_equipment_leg" }] }],
      [/FROM documents d/, (_sql: string, params?: unknown[]) => ({ rows: params?.[0] === APP_ID ? [file("own", true), file("own2", null)] : [file("parent", true)] })],
    ]));
    const app = await mount("/api/applications", "../../modules/applications/applications.routes.js");
    const res = await request(app).get(`/api/applications/${APP_ID}/documents`).set("Authorization", `Bearer ${staffToken()}`);
    expect(res.status).toBe(200);
    const files = res.body.categories.flatMap((c: any) => c.files);
    expect(Object.fromEntries(files.map((f: any) => [f.id, f.receivedInBackground]))).toEqual({ own: true, own2: false, parent: true });
    const queries = callsMatching(h.queryMock, /FROM documents d/);
    expect(queries).toHaveLength(2);
    for (const [sql] of queries) expect(sqlText(sql)).toContain("AS received_in_background");
  });

  it("migration is idempotent", () => {
    expect(migration).toContain("ADD COLUMN IF NOT EXISTS received_in_background");
  });
});
