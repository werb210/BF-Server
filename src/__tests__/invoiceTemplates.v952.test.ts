// BF_SERVER_v952_INVOICE_TEMPLATES
import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";
import { PDFDocument } from "pdf-lib";
import { readFileSync } from "node:fs";
import { answerBySql, callsMatching } from "./helpers/answerBySql.js";

const h = vi.hoisted(() => ({ query: vi.fn(), canSee: vi.fn(async () => true) }));
vi.mock("../db.js", async (orig) => {
  const real: any = await orig();
  const q = (sql: unknown, params?: unknown[]) => h.query(sql, params);
  const pool = { query: q, connect: async () => ({ query: q, release: () => undefined }) };
  return { ...real, dbQuery: q, runQuery: q, query: q, pool, db: pool, default: pool };
});
vi.mock("../brokerTools/platform.js", async (orig) => ({ ...(await orig() as object), canSeeApplication: (...a: unknown[]) => (h.canSee as any)(...a) }));
vi.mock("../signnow/sendApplicationForSignature.js", () => ({
  loadApplicationForPdf: vi.fn(async (id: string) => ({ applicationId: id, business: { legalName: "Maple Ridge Ltd.", address: "1 Main St", city: "Calgary", province: "AB", postal: "T2P 1A1" }, funding: {}, product: {}, owners: [{ firstName: "Sam", lastName: "Lee", email: "sam@example.test" }] })),
}));

import docsRouter from "../routes/licenseeDocuments.js";
import { invoiceTotals } from "../licenseeDocs/service.js";
import { valuesFor } from "../licenseeDocs/catalog.js";
import { DOC_KINDS } from "../licenseeDocs/repo.js";

const app = express();
app.use(express.json());
app.use("/api/licensee-documents", docsRouter);
const token = (role = "Staff") => "Bearer " + jwt.sign({ sub: "76767676-7676-4676-8676-767676767676", role, tokenVersion: 0, tv: 0 }, process.env.JWT_SECRET as string);
const APP = "a9a9a9a9-0000-4000-8000-000000000952";

async function template(): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  ["InvoiceNumber", "BillTo", "Total"].forEach((n, i) => doc.getForm().createTextField(n).addToPage(page, { x: 100, y: 700 - i * 30, width: 220, height: 18 }));
  return Buffer.from(await doc.save());
}
const FIELDS = [
  { name: "InvoiceNumber", label: "Invoice Number", type: "text", mapped_to: "invoice.number", matched_by: "words" },
  { name: "BillTo", label: "Bill To", type: "text", mapped_to: "business.legal_name", matched_by: "licensee" },
  { name: "Total", label: "Total", type: "text", mapped_to: "invoice.total", matched_by: "words" },
];

beforeEach(async () => {
  h.canSee.mockReset(); h.canSee.mockResolvedValue(true);
  const file = await template();
  h.query.mockReset();
  h.query.mockImplementation(answerBySql([
    [/nextval\('client_invoice_number_seq'\)/, { rows: [{ n: "1001" }] }],
    [/INSERT INTO client_invoices/, { rows: [] }],
    [/FROM client_invoices/, { rows: [{ id: "i1", number: "INV-01001", description: "Broker fee", amount: "5000.00", tax: "250.00", total: "5250.00", due_date: null, created_at: "2026-11-12" }] }],
    [/FROM licensee_documents\s+WHERE kind = \$1 AND active/, { rows: [{ id: "d1", kind: "invoice", name: "Our invoice", file_name: "inv.pdf", format: "pdf_form", fields: FIELDS, active: true, financing_type: null, file }] }],
    [/./, { rows: [] }],
  ]));
});

describe("invoice templates", () => {
  it("invoice is a kind of document a brokerage can upload", () => {
    expect(DOC_KINDS).toContain("invoice");
  });

  it("works out tax and total to the cent", () => {
    expect(invoiceTotals({ amount: 5000, taxPercent: 5 })).toEqual({ amount: 5000, tax: 250, total: 5250 });
    expect(invoiceTotals({ amount: 1234.56, taxPercent: 13 })).toEqual({ amount: 1234.56, tax: 160.49, total: 1395.05 });
    expect(invoiceTotals({ amount: 99.99, taxPercent: 0 })).toEqual({ amount: 99.99, tax: 0, total: 99.99 });
  });

  it("gives the template the invoice's number, dates and money", () => {
    const v = valuesFor({ app: { applicationId: APP, business: { legalName: "Maple Ridge Ltd." }, funding: {}, product: {}, owners: [] } as any, brokerName: "B",
      invoice: { number: "INV-01001", date: "2026-11-12", due_date: "2026-11-27", description: "Broker fee", amount: 5000, tax: 250, total: 5250 } });
    expect(v["invoice.number"]).toBe("INV-01001");
    expect(v["invoice.due_date"]).toBe("2026-11-27");
    expect(v["invoice.total"]).toContain("5,250");
  });

  it("makes the invoice as a PDF, numbers it and records it", async () => {
    const r = await request(app).post(`/api/licensee-documents/applications/${APP}/invoice`).set("Authorization", token())
      .send({ amount: "5,000", description: "Broker fee", tax_percent: 5, due_days: 15 }).buffer(true).parse((res, cb) => { const c: Buffer[] = []; res.on("data", (d: Buffer) => c.push(d)); res.on("end", () => cb(null, Buffer.concat(c))); });
    expect(r.status).toBe(200);
    expect(r.headers["content-type"]).toContain("application/pdf");
    expect(r.headers["x-invoice-number"]).toBe("INV-01001");
    expect((r.body as Buffer).subarray(0, 5).toString("latin1")).toBe("%PDF-");
    const ins = callsMatching(h.query, /INSERT INTO client_invoices/)[0]![1] as unknown[];
    expect(ins.slice(0, 6)).toEqual([APP, "INV-01001", "Broker fee", 5000, 250, 5250]);
    expect(String(ins[6])).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("refuses a missing amount, a missing description and silly tax", async () => {
    const post = (body: object) => request(app).post(`/api/licensee-documents/applications/${APP}/invoice`).set("Authorization", token()).send(body);
    expect((await post({ description: "x" })).status).toBe(400);
    expect((await post({ amount: 100 })).status).toBe(400);
    expect((await post({ amount: 100, description: "x", tax_percent: 80 })).status).toBe(400);
    expect(callsMatching(h.query, /INSERT INTO client_invoices/)).toHaveLength(0);
  });

  it("says to upload a template when there is none, and uses no invoice number", async () => {
    h.query.mockImplementation(answerBySql([[/./, { rows: [] }]]));
    const r = await request(app).post(`/api/licensee-documents/applications/${APP}/invoice`).set("Authorization", token()).send({ amount: 100, description: "Fee" });
    expect(r.status).toBe(409);
    expect(r.body.message ?? r.body.error?.message ?? JSON.stringify(r.body)).toContain("invoice template");
    expect(callsMatching(h.query, /nextval/)).toHaveLength(0);
  });

  it("someone who cannot see the file gets nothing", async () => {
    h.canSee.mockResolvedValue(false);
    expect((await request(app).post(`/api/licensee-documents/applications/${APP}/invoice`).set("Authorization", token()).send({ amount: 100, description: "Fee" })).status).toBe(404);
    expect((await request(app).get(`/api/licensee-documents/applications/${APP}/invoices`).set("Authorization", token())).status).toBe(404);
  });

  it("lists the file's invoices and whether a template exists", async () => {
    const r = await request(app).get(`/api/licensee-documents/applications/${APP}/invoices`).set("Authorization", token());
    expect(r.status).toBe(200);
    expect(r.body.has_template).toBe(true);
    expect(r.body.invoices[0].number).toBe("INV-01001");
  });

  it("the migration is safe to run twice", () => {
    const sql = readFileSync("migrations/2026_12_04_v952_invoice_templates.sql", "utf8");
    expect(sql).toContain("DROP CONSTRAINT IF EXISTS licensee_documents_kind_check");
    expect(sql).toContain("CREATE SEQUENCE IF NOT EXISTS client_invoice_number_seq");
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS client_invoices");
  });
});
