// BF_SERVER_LENDER_CONTACT_SYNC_v3 / BF_SERVER_LENDER_EDIT_ADDRESS_v1 /
// BF_SERVER_LENDER_COMPANY_PARITY_v1 / BF_SERVER_LENDER_PRODUCT_PARITY_v1 /
// BF_SERVER_LENDER_PRODUCT_NOTIFY_v1
// Staff form <-> lender portal field parity (company + products; commission
// stays staff-only) and staff notification on lender product create/update.
import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";
import { answerBySql, callsMatching, type SqlRule } from "./helpers/answerBySql.js";

const h = vi.hoisted(() => ({ query: vi.fn(), notifyAllStaff: vi.fn(), updateLender: vi.fn() }));
vi.mock("../db.js", async (orig) => ({ ...(await orig() as any), pool: { query: h.query, connect: vi.fn() }, runQuery: h.query, dbQuery: h.query }));
vi.mock("../services/notifications/notifyAllStaff.js", () => ({ notifyAllStaff: (...a: unknown[]) => h.notifyAllStaff(...a) }));
vi.mock("../services/lenderCrmMirror.js", () => ({ mirrorLenderToCrm: async () => undefined }));
import lenderSelf from "../routes/lenderSelf.js";
import portalLenders from "../routes/portalLenders.js";
import { updateLender } from "../repositories/lenders.repo.js";

const LENDER_ID = "11111111-2222-4333-8444-555555555555";
const lenderToken = "Bearer " + jwt.sign({ sub: "lender:" + LENDER_ID, role: "Lender", lenderId: LENDER_ID }, process.env.JWT_SECRET as string);
const staffToken = "Bearer " + jwt.sign({ sub: "99999999-9999-4999-8999-999999999999", role: "Admin", tokenVersion: 0, tv: 0 }, process.env.JWT_SECRET as string);

const app = express();
app.use(express.json());
app.use("/api/lender", lenderSelf);
app.use("/api/portal", portalLenders);

function answer(rules: SqlRule[]) { h.query.mockImplementation(answerBySql(rules)); }
beforeEach(() => {
  h.query.mockReset();
  answer([]);
  h.notifyAllStaff.mockReset();
  h.notifyAllStaff.mockResolvedValue({ smsSent: 0, notifsCreated: 1, recipientCount: 1 });
});

describe("lender contact parity", () => {
  it("lender profile prefers staff-edited primary_contact_name/email", async () => {
    answer([[/FROM lenders\s+WHERE id::text = \$1/, { rows: [{ id: LENDER_ID, contact_name: "Staff Edit" }] }]]);
    const r = await request(app).get("/api/lender/me").set("Authorization", lenderToken);
    expect(r.status).toBe(200);
    const sql = String(callsMatching(h.query, /FROM lenders\s+WHERE id::text = \$1/)[0][0]);
    expect(sql).toContain("COALESCE(NULLIF(primary_contact_name, ''), contact_name) AS contact_name");
    expect(sql).toContain("COALESCE(NULLIF(primary_contact_email, ''), contact_email) AS contact_email");
  });

  it("lender edits sync back to primary_contact_* columns", async () => {
    answer([[/UPDATE lenders/, { rows: [{ id: LENDER_ID }] }]]);
    const r = await request(app).patch("/api/lender/me").set("Authorization", lenderToken)
      .send({ contact_name: "Pat Lender", contact_email: "pat@lender.com", contact_phone: "+14035550123" });
    expect(r.status).toBe(200);
    const [sql, params] = callsMatching(h.query, /UPDATE lenders/)[0] as [string, unknown[]];
    expect(sql).toContain("contact_name = $2");
    expect(sql).toContain("primary_contact_name = $2");
    expect(sql).toContain("primary_contact_email = $3");
    expect(sql).toContain("primary_contact_phone = $4");
    expect(params).toEqual([LENDER_ID, "Pat Lender", "pat@lender.com", "+14035550123"]);
  });

  it("lender profile returns and accepts the staff-form field set", async () => {
    answer([[/FROM lenders\s+WHERE id::text = \$1/, { rows: [{ id: LENDER_ID }] }], [/UPDATE lenders/, { rows: [{ id: LENDER_ID }] }]]);
    await request(app).get("/api/lender/me").set("Authorization", lenderToken);
    expect(String(callsMatching(h.query, /FROM lenders\s+WHERE id::text = \$1/)[0][0])).toContain("application_url, announcement, submission_method, submission_email");
    await request(app).patch("/api/lender/me").set("Authorization", lenderToken)
      .send({ application_url: " https://apply.lender.com ", submission_email: "deals@lender.com", country: "CA" });
    const [sql, params] = callsMatching(h.query, /UPDATE lenders/)[0] as [string, unknown[]];
    expect(sql).toMatch(/SET country = \$2, application_url = \$3, submission_email = \$4/);
    expect(sql).toContain("RETURNING id, name, phone, website, description");
    expect(params).toEqual([LENDER_ID, "CA", "https://apply.lender.com", "deals@lender.com"]);
  });
});

describe("staff lender PATCH write-through", () => {
  it("portalLenders PATCH forwards address, phone, description", async () => {
    const columns = ["id", "name", "country", "status", "email", "submission_method", "submission_email", "api_config", "submission_config",
      "primary_contact_name", "primary_contact_email", "primary_contact_phone", "website", "created_at", "updated_at", "active",
      "street", "city", "region", "postal_code", "phone", "description", "silo"];
    answer([
      [/from information_schema\.columns/, { rows: columns.map((column_name) => ({ column_name })) }],
      [/UPDATE lenders/, { rows: [{ id: LENDER_ID, name: "Acme", silo: "BF" }] }],
      [/FROM lenders/, { rows: [{ id: LENDER_ID, name: "Acme", country: "CA", silo: "BF" }] }],
    ]);
    const r = await request(app).patch(`/api/portal/lenders/${LENDER_ID}`).set("Authorization", staffToken)
      .send({ street: "1 Main St", city: "Calgary", postalCode: "T2P 1A1", phone: "+14035550199", description: "Equipment lender" });
    expect(r.status).toBe(200);
    const [sql, params] = callsMatching(h.query, /UPDATE lenders/)[0] as [string, unknown[]];
    for (const [col, value] of [["street", "1 Main St"], ["city", "Calgary"], ["postal_code", "T2P 1A1"], ["phone", "+14035550199"], ["description", "Equipment lender"]]) {
      const i = params.indexOf(value);
      expect(i, col).toBeGreaterThan(-1);
      expect(sql).toContain(`${col} = $${i + 1}`);
    }
  });

  it("updateLender repo writes address, phone, description columns", async () => {
    answer([[/from information_schema\.columns/, { rows: ["id", "name", "street", "phone", "description"].map((column_name) => ({ column_name })) }]]);
    const db = { query: vi.fn(answerBySql([[/UPDATE lenders/, { rows: [{ id: LENDER_ID }] }]])) };
    await updateLender(db as any, { id: LENDER_ID, street: "9 Side Rd", phone: "+15875550100", description: "d" });
    const [sql, params] = callsMatching(db.query, /UPDATE lenders/)[0] as [string, unknown[]];
    expect(sql).toMatch(/SET street = \$1, phone = \$2, description = \$3\s+WHERE id = \$4/);
    expect(params).toEqual(["9 Side Rd", "+15875550100", "d", LENDER_ID]);
  });
});

describe("lender product parity", () => {
  it("lender products GET returns required_documents", async () => {
    answer([[/FROM lender_products/, { rows: [{ id: "p1", required_documents: [{ category: "bank" }] }] }]]);
    const r = await request(app).get("/api/lender/products").set("Authorization", lenderToken);
    expect(r.body.data[0].required_documents).toEqual([{ category: "bank" }]);
    const [sql, params] = callsMatching(h.query, /FROM lender_products/)[0] as [string, unknown[]];
    expect(sql).toMatch(/eligibility_notes,\s+required_documents/);
    expect(params).toEqual([LENDER_ID]);
  });

  it("lender product create/update accept active + required_documents", async () => {
    answer([[/UPDATE lender_products/, { rows: [{ id: "p1", name: "LOC" }] }], [/INSERT INTO lender_products/, { rows: [{ id: "p2", name: "Term" }] }]]);
    const docs = [{ category: "Bank statements", stage: 2 }, { category: "" }];
    await request(app).patch("/api/lender/products/p1").set("Authorization", lenderToken)
      .send({ name: "LOC", category: "LOC", active: false, required_documents: docs });
    const [sql, params] = callsMatching(h.query, /UPDATE lender_products/)[0] as [string, unknown[]];
    expect(sql).toContain("active = COALESCE($17, active)");
    expect(sql).toContain("required_documents = COALESCE($18::jsonb, required_documents)");
    expect(params[16]).toBe(false);
    expect(JSON.parse(String(params[17]))).toEqual([{ category: "Bank statements", required: true, description: null, stage: 2 }]);

    const c = await request(app).post("/api/lender/products").set("Authorization", lenderToken).send({ name: "Term", category: "TERM", active: true });
    expect(c.status).toBe(201);
    const ins = callsMatching(h.query, /INSERT INTO lender_products/)[0][1] as unknown[];
    expect(ins[15]).toBe(true); // active
  });
});

describe("lender product notifications", () => {
  it("create and update both notify staff with a product deep link", async () => {
    answer([
      [/SELECT name FROM lenders/, { rows: [{ name: "Acme Capital" }] }],
      [/UPDATE lender_products/, { rows: [{ id: "p1", name: "LOC" }] }],
      [/INSERT INTO lender_products/, { rows: [{ id: "p 2", name: "Term" }] }],
    ]);
    await request(app).post("/api/lender/products").set("Authorization", lenderToken).send({ name: "Term", category: "TERM" });
    await request(app).patch("/api/lender/products/p1").set("Authorization", lenderToken).send({ name: "LOC", category: "LOC" });
    await vi.waitFor(() => expect(h.notifyAllStaff).toHaveBeenCalledTimes(2));
    const [created] = h.notifyAllStaff.mock.calls[0] as [Record<string, unknown>];
    expect(created).toMatchObject({ title: "Lender product created", contextUrl: "/lenders?editProduct=p%202", refTable: "lender_products", silo: "BF" });
    expect(String(created.body)).toContain("Acme Capital created product \"Term\"");
    const [updated] = h.notifyAllStaff.mock.calls[1] as [Record<string, unknown>];
    expect(updated).toMatchObject({ title: "Lender product updated", contextUrl: "/lenders?editProduct=p1" });
  });

  it("an edit to someone else's product notifies nobody", async () => {
    answer([[/UPDATE lender_products/, { rows: [] }]]);
    const r = await request(app).patch("/api/lender/products/not-mine").set("Authorization", lenderToken).send({ name: "LOC", category: "LOC" });
    expect(r.status).toBe(404);
    expect(h.notifyAllStaff).not.toHaveBeenCalled();
  });
});
