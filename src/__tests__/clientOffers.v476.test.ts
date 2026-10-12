// BF_SERVER_BLOCK_v476
import { beforeEach, describe, it, expect, vi } from "vitest";
import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";
import { answerBySql, callsMatching, sqlText } from "./helpers/answerBySql.js";

const APP = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const OWNER = "+15875550123";
const h = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("../db.js", async (orig) => {
  const real: any = await orig();
  const q = (sql: unknown, params?: unknown[]) => h.query(sql, params);
  const pool = { query: q, connect: async () => ({ query: q, release: () => undefined }) };
  return { ...real, dbQuery: q, runQuery: q, query: q, pool, db: pool, default: pool };
});
vi.mock("../lib/storage/index.js", async (orig) => ({
  ...(await orig<any>()),
  getStorage: () => ({ getSignedUrl: async (blob: string) => "https://blob.test/signed/" + blob }),
}));

import clientRouter from "../routes/client/index.js";
import { attachTermSheetUrls } from "../routes/offers.js";

const app = express();
app.use(express.json());
app.use("/api/client", clientRouter);
const token = (phone: string) => "Bearer " + jwt.sign({ sub: "client:" + phone, role: "client", phone, isClient: true }, process.env.JWT_SECRET as string, { algorithm: "HS256" });

const OFFER = { id: "o1", application_id: APP, lender_name: "North Bank", amount: "250000", status: "pending", document_url: null };
const REJECTED = { id: "d1", category: "Bank Statements", filename: "jan.pdf", status: "rejected", rejection_reason: "blurry" };

beforeEach(() => {
  h.query.mockReset();
  h.query.mockImplementation(answerBySql([
    // The router-wide guard does not recognise the id, so what answers below is the route's own signing-owner guard.
    [/FROM applications WHERE lower\(id::text\) = ANY/, { rows: [] }],
    [/WITH app_phones AS/, (_s: string, p?: unknown[]) => ({ rows: [{ total: 1, mine: p?.[1] === OWNER.slice(-10) ? 1 : 0, known: 1 }] })],
    [/term_sheet_blob_name from offers/, { rows: [{ id: "o1", term_sheet_blob_name: "term-sheets/o1.pdf" }] }],
    [/FROM offers o/, { rows: [OFFER] }],
    [/FROM documents d/, { rows: [REJECTED] }],
  ]));
});

describe("v476 client offers + rejected documents", () => {
  for (const path of ["/offers", "/rejected-documents"]) {
    it(`${path} is owner-guarded`, async () => {
      const none = await request(app).get(`/api/client${path}?applicationId=${APP}`);
      expect(none.status).toBe(401);
      expect(none.body).toEqual({ error: "sign_in_required" });
      const other = await request(app).get(`/api/client${path}?applicationId=${APP}`).set("Authorization", token("+15875550199"));
      expect(other.status).toBe(403);
      expect(other.body).toEqual({ error: "not_your_application" });
      expect(callsMatching(h.query, /FROM offers o|FROM documents d/)).toHaveLength(0);
      const mine = await request(app).get(`/api/client${path}?applicationId=${APP}`).set("Authorization", token(OWNER));
      expect(mine.status).toBe(200);
      expect(mine.body.items).toHaveLength(1);
    });
  }

  it("the rejected-documents banner reads only this application's rejected documents", async () => {
    const r = await request(app).get(`/api/client/rejected-documents?applicationId=${APP}`).set("Authorization", token(OWNER));
    expect(r.body.items).toEqual([REJECTED]);
    const [read] = callsMatching(h.query, /FROM documents d/);
    expect(read![1]).toEqual([APP]);
    expect(sqlText(read![0])).toContain("= 'rejected'");
  });

  it("reuses the staff term-sheet URL helper", async () => {
    const r = await request(app).get(`/api/client/offers?applicationId=${APP}`).set("Authorization", token(OWNER));
    expect(r.body.items).toEqual([{ ...OFFER, document_url: "https://blob.test/signed/term-sheets/o1.pdf" }]);
    // Same answer as the staff helper gives for the same rows.
    expect(await attachTermSheetUrls([OFFER])).toEqual(r.body.items);
    expect(callsMatching(h.query, /FROM offers o/)[0]![1]).toEqual([APP]);
  });
});
