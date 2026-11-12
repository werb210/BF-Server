// BF_SERVER_v948_TERM_SHEET_BY_TYPE - a term sheet template per type of financing, with a general fallback.
import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";
import { PDFDocument } from "pdf-lib";
import { readFileSync } from "node:fs";
import { answerBySql, callsMatching } from "./helpers/answerBySql.js";

const h = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("../db.js", async (orig) => {
  const real: any = await orig();
  const q = (sql: unknown, params?: unknown[]) => h.query(sql, params);
  const pool = { query: q, connect: async () => ({ query: q, release: () => undefined }) };
  return { ...real, dbQuery: q, runQuery: q, query: q, pool, db: pool, default: pool };
});

import docsRouter from "../routes/licenseeDocuments.js";
import { activeDocument } from "../licenseeDocs/repo.js";

const app = express();
app.use(express.json());
app.use("/api/licensee-documents", docsRouter);
const token = (role: string) => "Bearer " + jwt.sign({ sub: "76767676-7676-4676-8676-767676767676", role, tokenVersion: 0, tv: 0 }, process.env.JWT_SECRET as string);
const ID = "dddddddd-1111-4111-8111-111111111111";
const DOC = { id: ID, kind: "term_sheet", name: "Equipment term sheet", file_name: "f.pdf", format: "pdf_form", active: true, financing_type: "EQUIPMENT_FINANCE", created_at: "", updated_at: "" };

async function pdf(): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  doc.getForm().createTextField("ApprovedAmount").addToPage(page, { x: 100, y: 700, width: 200, height: 18 });
  return Buffer.from(await doc.save());
}

beforeEach(() => {
  delete process.env.OPENAI_API_KEY;
  h.query.mockReset();
  h.query.mockImplementation(answerBySql([
    [/INSERT INTO licensee_documents/, (_s: string, p?: unknown[]) => ({ rows: [{ ...DOC, financing_type: p?.[7] ?? null, fields: JSON.parse(String(p?.[5])) }] })],
    [/SELECT kind, active FROM licensee_documents/, { rows: [{ kind: "term_sheet", active: true }] }],
    [/UPDATE licensee_documents SET financing_type/, (_s: string, p?: unknown[]) => ({ rows: [{ ...DOC, financing_type: p?.[1] ?? null }] })],
    [/licensee_wizard_questions/, { rows: [] }],
    [/licensee_documents/, { rows: [] }],
  ]));
});

describe("term sheet templates by type of financing", () => {
  it("lists the types of financing a template can be for", async () => {
    const r = await request(app).get("/api/licensee-documents").set("Authorization", token("Staff"));
    expect(r.status).toBe(200);
    const keys = r.body.financingTypes.map((t: any) => t.key);
    expect(keys).toEqual(expect.arrayContaining(["TERM_LOAN", "LINE_OF_CREDIT", "EQUIPMENT_FINANCE", "FACTORING", "PURCHASE_ORDER_FINANCE", "MERCHANT_CASH_ADVANCE", "ASSET_BASED_LENDING"]));
  });

  it("stores the type on upload and only replaces the template of that same type", async () => {
    const r = await request(app).post("/api/licensee-documents").set("Authorization", token("Admin"))
      .field("kind", "term_sheet").field("financing_type", "EQUIPMENT_FINANCE").attach("file", await pdf(), "f.pdf");
    expect(r.status).toBe(201);
    expect(r.body.document.financing_type).toBe("EQUIPMENT_FINANCE");
    const off = callsMatching(h.query, /UPDATE licensee_documents SET active = false/);
    expect(off).toHaveLength(1);
    expect(String(off[0][0])).toContain("COALESCE(financing_type, '') = COALESCE($2, '')");
    expect(off[0][1]).toEqual(["term_sheet", "EQUIPMENT_FINANCE"]);
  });

  it("an upload with no type is the general template", async () => {
    const r = await request(app).post("/api/licensee-documents").set("Authorization", token("Admin")).field("kind", "term_sheet").attach("file", await pdf(), "f.pdf");
    expect(r.status).toBe(201);
    expect(r.body.document.financing_type).toBeNull();
  });

  it("refuses a type that is not on the list", async () => {
    const r = await request(app).post("/api/licensee-documents").set("Authorization", token("Admin"))
      .field("kind", "term_sheet").field("financing_type", "MORTGAGE_ISH").attach("file", await pdf(), "f.pdf");
    expect(r.status).toBe(400);
    expect(callsMatching(h.query, /INSERT INTO licensee_documents/)).toHaveLength(0);
  });

  it("an admin can change which type a template is for", async () => {
    const r = await request(app).patch(`/api/licensee-documents/${ID}`).set("Authorization", token("Admin")).send({ financing_type: "FACTORING" });
    expect(r.status).toBe(200);
    expect(r.body.document.financing_type).toBe("FACTORING");
    const bad = await request(app).patch(`/api/licensee-documents/${ID}`).set("Authorization", token("Admin")).send({ financing_type: "NOPE" });
    expect(bad.status).toBe(400);
  });

  it("picks the template for the file's type first, then the general one", async () => {
    const q = { query: vi.fn(async () => ({ rows: [] })) } as any;
    await activeDocument(q, "term_sheet", "FACTORING");
    const [sql, params] = q.query.mock.calls[0];
    expect(String(sql)).toContain("(financing_type IS NULL OR financing_type = $2)");
    expect(String(sql)).toContain("ORDER BY (financing_type IS NULL)");
    expect(params).toEqual(["term_sheet", "FACTORING"]);
  });

  it("the migration is safe to run twice", () => {
    const sql = readFileSync("migrations/2026_12_03_v948_term_sheet_by_type.sql", "utf8");
    expect(sql).toContain("ADD COLUMN IF NOT EXISTS financing_type");
    expect(sql).toContain("DROP INDEX IF EXISTS licensee_documents_one_active_kind");
    expect(sql).toContain("CREATE UNIQUE INDEX IF NOT EXISTS licensee_documents_one_active_kind_type");
  });
});
