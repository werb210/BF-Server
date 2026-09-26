import express from "express";
import jwt from "jsonwebtoken";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/modules/ai/knowledge.service.js", () => ({
  embedAndStore: vi.fn().mockResolvedValue(undefined),
}));

import settingsRouter from "../../src/routes/settings.js";
import { errorHandler } from "../../src/middleware/errors.js";
import { pool } from "../../src/db.js";
import * as knowledgeService from "../../src/modules/ai/knowledge.service.js";

function bearerToken() {
  process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret";
  const token = jwt.sign({ id: "u1", userId: "u1", role: "Admin", capabilities: ["settings:read"] }, process.env.JWT_SECRET);
  return `Bearer ${token}`;
}

describe("settings ai-knowledge routes", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(pool, "query").mockImplementation(async (text: any) => {
      const sql = String(text);
      if (sql.includes("FROM users")) {
        return { rows: [{ id: "u1", role: "Admin", email: "admin@example.com", silo: "BF", silos: ["BF"] }] } as any;
      }
      if (sql.includes("FROM ai_knowledge")) {
        return { rows: [{ id: "doc-1", source_type: "text", source_id: null, content: "sample", created_at: new Date().toISOString() }] } as any;
      }
      return { rows: [] } as any;
    });
  });

  function app() {
    const a = express();
    a.use(express.json());
    a.use("/api/settings", settingsRouter);
    a.use(errorHandler);
    return a;
  }

  it("POST /ai-knowledge/text with empty body returns 400", async () => {
    const res = await request(app())
      .post("/api/settings/ai-knowledge/text")
      .set("authorization", bearerToken())
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.error?.code).toBe("validation_error");
  });

  it("POST /ai-knowledge/text stores content via embedAndStore", async () => {
    const embedSpy = vi.spyOn(knowledgeService, "embedAndStore").mockResolvedValue(undefined as any);

    const res = await request(app())
      .post("/api/settings/ai-knowledge/text")
      .set("authorization", bearerToken())
      .send({ content: "hello world", title: "my title" });

    expect(res.status).toBe(200);
    expect(embedSpy).toHaveBeenCalled();
  });

  it("GET /ai-knowledge returns documents array", async () => {
    const res = await request(app())
      .get("/api/settings/ai-knowledge")
      .set("authorization", bearerToken());

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data?.documents)).toBe(true);
  });

  it("DELETE /ai-knowledge/:id removes row", async () => {
    const res = await request(app())
      .delete("/api/settings/ai-knowledge/doc-1")
      .set("authorization", bearerToken());

    expect(res.status).toBe(200);
    expect(pool.query).toHaveBeenCalledWith("DELETE FROM ai_knowledge WHERE id::text = $1", ["doc-1"]); // BF_SERVER_BLOCK_v577 - id compared as text
  });
});
