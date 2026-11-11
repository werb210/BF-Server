// BF_SERVER_v938_OUR_TERM_SHEET - BF's Settings > Your documents takes the brokerage's term sheet template.
import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";
import { PDFDocument } from "pdf-lib";
import { answerBySql, callsMatching, sqlText } from "./helpers/answerBySql.js";

const h = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("../db.js", async (orig) => {
  const real: any = await orig();
  const q = (sql: unknown, params?: unknown[]) => h.query(sql, params);
  const pool = { query: q, connect: async () => ({ query: q, release: () => undefined }) };
  return { ...real, dbQuery: q, runQuery: q, query: q, pool, db: pool, default: pool };
});

import docsRouter from "../routes/licenseeDocuments.js";

const app = express();
app.use(express.json());
app.use("/api/licensee-documents", docsRouter);
const token = (role: string) => "Bearer " + jwt.sign({ sub: "76767676-7676-4676-8676-767676767676", role, tokenVersion: 0, tv: 0 }, process.env.JWT_SECRET as string);

async function pdfWith(names: string[]): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  names.forEach((n, i) => doc.getForm().createTextField(n).addToPage(page, { x: 100, y: 700 - i * 30, width: 200, height: 18 }));
  return Buffer.from(await doc.save());
}

const DOC = { id: "dddddddd-1111-4111-8111-111111111111", kind: "term_sheet", name: "Our term sheet", file_name: "f.pdf", format: "pdf_form", active: true, created_at: "", updated_at: "" };

beforeEach(() => {
  delete process.env.OPENAI_API_KEY;
  h.query.mockReset();
  h.query.mockImplementation(answerBySql([
    [/INSERT INTO licensee_documents/, (_s: string, p?: unknown[]) => ({ rows: [{ ...DOC, fields: JSON.parse(String(p?.[5])) }] })],
    [/SELECT key FROM licensee_wizard_questions/, { rows: [] }],
    [/FROM licensee_wizard_questions q JOIN licensee_documents d/, (s: string) => ({ rows: /q\.active AND d\.active/.test(s)
      ? [{ id: "q1", document_id: DOC.id, key: "fleet_size", label: "Fleet size", type: "text", options: [], required: true, active: true, sort: 0 },
         { id: "q2", document_id: DOC.id, key: "fleet_size", label: "Fleet size (dup)", type: "text", options: [], required: false, active: true, sort: 1 }]
      : [] })],
  ]));
});

describe("Settings > Your documents (BF)", () => {
  it("offers only the term sheet (and other) kinds", async () => {
    h.query.mockImplementation(answerBySql([[/FROM licensee_documents/, { rows: [] }], [/licensee_wizard_questions/, { rows: [] }]]));
    const r = await request(app).get("/api/licensee-documents").set("Authorization", token("Staff"));
    expect(r.status).toBe(200);
    expect(r.body.kinds.map((k: any) => k.key)).toEqual(["term_sheet", "other"]);
  });

  it("refuses an application form, which BF does not use", async () => {
    const r = await request(app).post("/api/licensee-documents").set("Authorization", token("Admin")).field("kind", "application_form").attach("file", await pdfWith(["BusinessLegalName"]), "f.pdf");
    expect(r.status).toBe(400);
  });

  it("reads and matches a term sheet's fields, including our fees", async () => {
    const r = await request(app).post("/api/licensee-documents").set("Authorization", token("Admin"))
      .field("kind", "term_sheet").attach("file", await pdfWith(["Business Legal Name", "Setup Fee", "Interest Rate"]), "Term sheet.pdf");
    expect(r.status).toBe(201);
    expect(r.body.document.fields.map((f: any) => [f.name, f.mapped_to])).toEqual([["Business Legal Name", "business.legal_name"], ["Setup Fee", "offer.setup_fee"], ["Interest Rate", "offer.rate"]]);
  });
});
