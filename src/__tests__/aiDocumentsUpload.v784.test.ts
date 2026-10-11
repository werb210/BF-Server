// BF_SERVER_v784_AI_DOCS_UPLOAD - POST /api/admin/ai-documents (multipart "file")
// stores the upload in ai_knowledge by file name, so GET /api/admin/ai-documents
// (what the AI Knowledge Base page reads) lists it. Admin only.
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";

type Row = { id: string; title: string; source_type: string; source_id: string | null; content: string };
const store: Row[] = [];
let embedMode: "ok" | "no_key" = "ok";

vi.mock("../db.js", () => {
  const query = vi.fn(async (sql: string, params: any[] = []) => {
    if (/FROM ai_knowledge ORDER BY created_at DESC/i.test(sql)) {
      return { rows: [...store].reverse().map((r) => ({ id: r.id, name: r.source_id ?? r.content.slice(0, 60) })) };
    }
    if (/insert into ai_knowledge/i.test(sql)) {
      store.push({ id: `k${store.length + 1}`, title: params[1], source_type: params[2], source_id: params[3], content: params[4] });
      return { rows: [] };
    }
    return { rows: [] };
  });
  return { pool: { query }, runQuery: query, db: { query }, dbQuery: query, query };
});

vi.mock("../modules/ai/knowledge.service.js", () => ({
  embedAndStore: vi.fn(async (db: any, content: string, sourceType: string, sourceId?: string | null, title?: string | null) => {
    const tag = embedMode === "no_key" ? ":no-embed" : "";
    await db.query(
      "insert into ai_knowledge (id, title, source_type, source_id, content, embedding) values ($1, $2, $3, $4, $5, NULL)",
      ["x", title, sourceType + tag, sourceId ?? null, content],
    );
    if (embedMode === "no_key") throw Object.assign(new Error("no key"), { code: "openai_not_configured" });
  }),
}));

import adminRoutes from "../routes/admin.js";

const SECRET = process.env.JWT_SECRET || "test-jwt-secret";
const tok = (role: string) => jwt.sign({ id: "00000000-0000-0000-0000-0000000000a1", sub: "00000000-0000-0000-0000-0000000000a1", role }, SECRET, { algorithm: "HS256", expiresIn: "5m" });

const app = express();
app.use(express.json());
app.use("/api/admin", adminRoutes);

beforeEach(() => { store.length = 0; embedMode = "ok"; });

describe("POST /api/admin/ai-documents", () => {
  it("stores the file by name and the GET lists it", async () => {
    const up = await request(app)
      .post("/api/admin/ai-documents")
      .set("Authorization", `Bearer ${tok("Admin")}`)
      .attach("file", Buffer.from("Equipment financing FAQ\nTerms run 12 to 60 months."), { filename: "equipment-faq.txt", contentType: "text/plain" });
    expect(up.status).toBe(201);
    expect(up.body).toMatchObject({ ok: true, name: "equipment-faq.txt", indexed: true });
    expect(store[0]).toMatchObject({ source_id: "equipment-faq.txt", title: "equipment-faq.txt", source_type: "sheet" });
    expect(store[0]!.content).toContain("Terms run 12 to 60 months.");

    const list = await request(app).get("/api/admin/ai-documents").set("Authorization", `Bearer ${tok("Admin")}`);
    expect(list.status).toBe(200);
    expect(list.body.map((r: any) => r.name)).toContain("equipment-faq.txt");
  });

  it("still saves (unindexed) when embeddings are not configured", async () => {
    embedMode = "no_key";
    const up = await request(app)
      .post("/api/admin/ai-documents")
      .set("Authorization", `Bearer ${tok("Admin")}`)
      .attach("file", Buffer.from("hello world"), { filename: "notes.txt", contentType: "text/plain" });
    expect(up.status).toBe(201);
    expect(up.body).toMatchObject({ ok: true, name: "notes.txt", indexed: false });
    expect(store).toHaveLength(1);
  });

  it("400s without a file", async () => {
    const r = await request(app).post("/api/admin/ai-documents").set("Authorization", `Bearer ${tok("Admin")}`);
    expect(r.status).toBe(400);
    expect(store).toHaveLength(0);
  });

  it("refuses non-admin staff and anonymous callers", async () => {
    const staff = await request(app)
      .post("/api/admin/ai-documents")
      .set("Authorization", `Bearer ${tok("Staff")}`)
      .attach("file", Buffer.from("x"), { filename: "x.txt", contentType: "text/plain" });
    expect(staff.status).toBe(403);
    const anon = await request(app).post("/api/admin/ai-documents").attach("file", Buffer.from("x"), { filename: "x.txt", contentType: "text/plain" });
    expect(anon.status).toBe(401);
    expect(store).toHaveLength(0);
  });
});
