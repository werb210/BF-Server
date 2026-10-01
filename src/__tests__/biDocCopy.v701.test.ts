// BF_SERVER_BI_DOC_COPY_v701
import express from "express";
import request from "supertest";
import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ linked: true, files: {} as Record<string, Buffer> }));

vi.mock("../db.js", () => ({
  pool: {
    query: async (sql: string, params: unknown[] = []) => {
      if (sql.includes("FROM documents d JOIN applications a") && sql.includes("bi_public_id IS NOT NULL")) {
        if (!state.linked || params[0] !== "11111111-1111-4111-8111-111111111111") return { rows: [] };
        return { rows: [{ filename: "Statements June 2026.pdf", title: null, storage_key: null, blob_name: "docs/june.pdf", storage_path: null }] };
      }
      return { rows: [] };
    },
  },
}));
vi.mock("../modules/applications/applications.repo.js", () => ({ findActiveDocumentVersion: async () => null }));
vi.mock("../lib/storage/index.js", () => ({
  getStorage: () => ({ get: async (key: string) => (state.files[key] ? { buffer: state.files[key], contentType: "application/pdf" } : null) }),
}));
vi.mock("../services/smsService.js", () => ({ sendSMS: vi.fn() }));
vi.mock("../services/email/graphSendService.js", () => ({ sendViaGraph: vi.fn() }));

const ID = "11111111-1111-4111-8111-111111111111";
async function app() {
  const { default: router } = await import("../routes/serviceBridge.js");
  const a = express();
  a.use("/api/service", router);
  return a;
}

beforeEach(() => {
  process.env.BACKEND_SERVICE_TOKEN = "test-token-v701";
  state.linked = true;
  state.files = { "docs/june.pdf": Buffer.from("%PDF-june") };
});

describe("v701 BI can fetch the file behind a copied document", () => {
  it("returns the file for a document on a BI-linked application", async () => {
    const res = await request(await app()).get(`/api/service/bi-documents/${ID}/file`).set("x-backend-token", "test-token-v701");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("application/pdf");
    expect(Buffer.from(res.body).toString()).toBe("%PDF-june");
  });
  it("refuses without the service token", async () => {
    const res = await request(await app()).get(`/api/service/bi-documents/${ID}/file`);
    expect(res.status).toBe(401);
  });
  it("does not serve documents of applications that are not linked to BI", async () => {
    state.linked = false;
    const res = await request(await app()).get(`/api/service/bi-documents/${ID}/file`).set("x-backend-token", "test-token-v701");
    expect(res.status).toBe(404);
  });
  it("rejects a malformed id", async () => {
    const res = await request(await app()).get("/api/service/bi-documents/not-an-id/file").set("x-backend-token", "test-token-v701");
    expect(res.status).toBe(400);
  });
});

describe("v701 every document reaches the linked PGI application", () => {
  const mirror = readFileSync("src/services/biDocMirror.ts", "utf8");
  it("catch-up resends anything not yet copied, whatever its age", () => {
    expect(mirror).toContain("AND d.bi_mirrored_at IS NULL");
    expect(mirror).not.toContain("d.created_at >= now() - ($1 || ' days')::interval");
    expect(mirror).toContain("UPDATE documents SET bi_mirrored_at = now()");
  });
  it("copies existing documents as soon as the application is linked at submit", () => {
    const v1 = readFileSync("src/routes/client/v1Applications.ts", "utf8");
    expect(v1).toContain("m.mirrorApplicationDocsToBi(v330_t.bfApplicationId)");
  });
  it("adds the bi_mirrored_at column idempotently", () => {
    expect(readFileSync("migrations/2026_10_01_v701_bi_mirrored_at.sql", "utf8")).toContain("ADD COLUMN IF NOT EXISTS bi_mirrored_at");
  });
});
