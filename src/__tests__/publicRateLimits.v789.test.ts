// BF_SERVER_v789_PUBLIC_RATE_LIMITS - POST /api/support and POST /api/client/issues
// are public: 5 a minute per IP, and an issue screenshot is capped at 5 MB.
// (POST /api/public/conversation/:id/message, 20 a minute, is covered in
// mayaEscalateTokens.v789.test.ts.)
import { describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";

vi.mock("../db.js", async (orig) => {
  const real: any = await orig();
  const q = async (sql: string) => (/RETURNING/.test(String(sql)) ? { rows: [{ id: "row-1" }] } : { rows: [] });
  const pool = { query: q };
  return { ...real, dbQuery: q, query: q, pool, default: pool };
});

async function mount(path: string, loader: () => Promise<any>) {
  const a = express();
  a.use(express.json({ limit: "10mb" }));
  a.use(path, (await loader()).default);
  return a;
}

describe("POST /api/support", () => {
  it("5 a minute per IP, the 6th is 429, another IP is unaffected", async () => {
    const a = await mount("/api/support", () => import("../routes/support.js"));
    for (let i = 0; i < 5; i += 1) {
      expect((await request(a).post("/api/support").set("X-Forwarded-For", "192.0.2.30").send({ message: "hi" })).status).toBe(201);
    }
    expect((await request(a).post("/api/support").set("X-Forwarded-For", "192.0.2.30").send({ message: "hi" })).status).toBe(429);
    expect((await request(a).post("/api/support").set("X-Forwarded-For", "192.0.2.31").send({ message: "hi" })).status).toBe(201);
  });
});

describe("POST /api/client/issues", () => {
  it("5 a minute per IP, the 6th is 429", async () => {
    const a = await mount("/api/client/issues", () => import("../routes/clientIssues.js"));
    for (let i = 0; i < 5; i += 1) {
      expect((await request(a).post("/api/client/issues").set("X-Forwarded-For", "192.0.2.40").send({ message: "bug" })).status).toBe(201);
    }
    expect((await request(a).post("/api/client/issues").set("X-Forwarded-For", "192.0.2.40").send({ message: "bug" })).status).toBe(429);
  });

  it("a screenshot over 5 MB is refused with 413, one under is stored", async () => {
    const a = await mount("/api/client/issues", () => import("../routes/clientIssues.js"));
    const { MAX_SCREENSHOT_BYTES } = await import("../routes/clientIssues.js");
    const b64Len = (bytes: number) => Math.ceil(bytes / 3) * 4;
    const big = "data:image/png;base64," + "A".repeat(b64Len(MAX_SCREENSHOT_BYTES + 3));
    const ok = "A".repeat(b64Len(1024));
    expect((await request(a).post("/api/client/issues").set("X-Forwarded-For", "192.0.2.41").send({ message: "bug", screenshotBase64: big })).status).toBe(413);
    expect((await request(a).post("/api/client/issues").set("X-Forwarded-For", "192.0.2.42").send({ message: "bug", screenshotBase64: ok })).status).toBe(201);
  });

  it("base64DecodedBytes measures the decoded size", async () => {
    const { base64DecodedBytes } = await import("../routes/clientIssues.js");
    expect(base64DecodedBytes(Buffer.from("hello world").toString("base64"))).toBe(11);
    expect(base64DecodedBytes("data:image/png;base64," + Buffer.alloc(300).toString("base64"))).toBe(300);
  });
});
