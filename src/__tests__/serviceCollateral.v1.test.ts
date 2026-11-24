// BF_SERVER_SERVICE_COLLATERAL_v1
import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const ID = "22222222-2222-4222-8222-222222222222";
vi.mock("../db.js", () => {
  const query = async (sql: string, params: unknown[] = []) => {
    if (sql.includes("FROM collateral_assets ORDER BY")) return { rows: [{ id: ID, name: "BI - US - SBA - 1 Pager", content_type: "application/pdf", size_bytes: 4, silo: "BF" }] };
    if (sql.includes("FROM collateral_assets WHERE id::text = $1")) return { rows: params[0] === ID ? [{ name: "BI - US - SBA - 1 Pager", content_type: "application/pdf", blob_name: "c/one.pdf" }] : [] };
    return { rows: [] };
  };
  return { pool: { query, connect: async () => ({ query, release: () => undefined }) }, runQuery: query };
});
vi.mock("../modules/applications/applications.repo.js", () => ({ findActiveDocumentVersion: async () => null }));
vi.mock("../lib/storage/index.js", () => ({
  getStorage: () => ({ get: async (key: string) => (key === "c/one.pdf" ? { buffer: Buffer.from("%PDF"), contentType: "application/pdf" } : null) }),
}));
vi.mock("../services/smsService.js", () => ({ sendSMS: vi.fn() }));
vi.mock("../services/email/graphSendService.js", () => ({ sendViaGraph: vi.fn() }));

async function app() {
  const { default: router } = await import("../routes/serviceBridge.js");
  const a = express();
  a.use("/api/service", router);
  return a;
}
beforeEach(() => { process.env.BACKEND_SERVICE_TOKEN = "svc-token"; });

describe("service collateral", () => {
  it("lists collateral and returns one file for BI-Server", async () => {
    const a = await app();
    const list = await request(a).get("/api/service/collateral").set("x-backend-token", "svc-token");
    expect(list.status).toBe(200);
    expect(list.body.items[0].name).toBe("BI - US - SBA - 1 Pager");
    const file = await request(a).get(`/api/service/collateral/${ID}/file`).set("x-backend-token", "svc-token");
    expect(file.status).toBe(200);
    expect(file.headers["content-type"]).toContain("application/pdf");
  });
  it("refuses without the service token and 404s an unknown file", async () => {
    const a = await app();
    expect((await request(a).get("/api/service/collateral")).status).toBe(401);
    const miss = await request(a).get("/api/service/collateral/33333333-3333-4333-8333-333333333333/file").set("x-backend-token", "svc-token");
    expect(miss.status).toBe(404);
  });
});
