// BF_SERVER_v936_CLIENT_OFFER_CLEANUP - review fixes: silo on send-for-signature, a sandboxed Word page,
// a fresh SignNow link on each load, and "signed" tied to this offer's SignNow document.
import { beforeEach, describe, it, expect, vi } from "vitest";
import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";
import { answerBySql, callsMatching, sqlText } from "./helpers/answerBySql.js";

const APP = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const OWNER = "+15875550123";
const h = vi.hoisted(() => ({ query: vi.fn(), link: vi.fn() }));
vi.mock("../db.js", async (orig) => {
  const real: any = await orig();
  const q = (sql: unknown, params?: unknown[]) => h.query(sql, params);
  const pool = { query: q, connect: async () => ({ query: q, release: () => undefined }) };
  return { ...real, dbQuery: q, runQuery: q, query: q, pool, db: pool, default: pool };
});
vi.mock("../lib/storage/index.js", async (orig) => ({
  ...(await orig<any>()),
  getStorage: () => ({ getSignedUrl: async (blob: string) => "https://blob.test/signed/" + blob, get: async () => null }),
}));
vi.mock("../signnow/signnowClient.js", async (orig) => ({ ...(await orig<any>()), createEmbeddedGroupLink: (...a: unknown[]) => h.link(...a) }));

import clientRouter from "../routes/client/index.js";
import offersRouter from "../routes/offers.js";
import { safeDocHtml, TERM_SHEET_VIEW_CSP } from "../brokerTools/termSheetView.js";

const app = express();
app.use(express.json());
app.use("/api/client", clientRouter);
app.use("/api/offers", offersRouter);
const client = "Bearer " + jwt.sign({ sub: "client:" + OWNER, role: "client", phone: OWNER, isClient: true }, process.env.JWT_SECRET as string, { algorithm: "HS256" });
const staff = "Bearer " + jwt.sign({ sub: "76767676-7676-4676-8676-767676767676", role: "Admin", tokenVersion: 0, tv: 0 }, process.env.JWT_SECRET as string);

const SESSION = { offer_id: "o1", group_id: "g1", invite_id: "i1", signer_email: "c@example.test", doc_id: "d1", signing_url: "https://signnow.test/old" };
let offerRow: Record<string, unknown>;

beforeEach(() => {
  h.query.mockReset(); h.link.mockReset();
  offerRow = { id: "o1", application_id: APP, lender_name: "North Bank", document_url: null, has_term_sheet: true, signing_url: SESSION.signing_url, signnow_session: SESSION, signed: false };
  h.query.mockImplementation(answerBySql([
    [/FROM applications WHERE lower\(id::text\) = ANY/, { rows: [] }],
    [/WITH app_phones AS/, () => ({ rows: [{ total: 1, mine: 1, known: 1 }] })],
    [/FROM offers o\s+LEFT JOIN applications a/, () => ({ rows: [offerRow] })],
  ]));
});

describe("client offers", () => {
  it("hands the client a fresh SignNow link and never the stored session", async () => {
    h.link.mockResolvedValue({ url: "https://signnow.test/fresh", expiresAt: null });
    const r = await request(app).get(`/api/client/offers?applicationId=${APP}`).set("Authorization", client);
    expect(r.status).toBe(200);
    expect(h.link).toHaveBeenCalledWith("g1", "i1", "c@example.test");
    expect(r.body.items[0].signing_url).toBe("https://signnow.test/fresh");
    expect(r.body.items[0]).not.toHaveProperty("signnow_session");
  });

  it("keeps the stored link when SignNow does not answer, and makes no link for a signed offer", async () => {
    h.link.mockRejectedValue(new Error("down"));
    const r = await request(app).get(`/api/client/offers?applicationId=${APP}`).set("Authorization", client);
    expect(r.body.items[0].signing_url).toBe("https://signnow.test/old");
    h.link.mockClear();
    offerRow = { ...offerRow, signed: true };
    await request(app).get(`/api/client/offers?applicationId=${APP}`).set("Authorization", client);
    expect(h.link).not.toHaveBeenCalled();
  });

  it("counts an offer as signed only for its own SignNow document", async () => {
    h.link.mockResolvedValue({ url: "https://signnow.test/fresh" });
    await request(app).get(`/api/client/offers?applicationId=${APP}`).set("Authorization", client);
    const sql = sqlText(callsMatching(h.query, /FROM offers o\s+LEFT JOIN applications a/)[0]![0]);
    expect(sql).toContain("v.metadata->>'docId' = a.metadata->'offer_signnow'->>'doc_id'");
  });
});

describe("send for signature", () => {
  it("looks the offer up within the caller's silo and sends nothing when it is not found", async () => {
    const r = await request(app).post("/api/offers/o9/send-for-signature").set("Authorization", staff).send({});
    const [call] = callsMatching(h.query, /from offers o\s+join applications a/i);
    expect(r.status).toBe(404); {
      expect(r.status).toBe(404);
      expect(sqlText(call![0])).toMatch(/a\.silo = \$2::text/);
      expect(call![1]![0]).toBe("o9");
    }
    expect(h.link).not.toHaveBeenCalled();
  });
});

describe("Word term sheet page", () => {
  it("drops javascript and data links, scripts and event handlers, and keeps ordinary links", () => {
    const out = safeDocHtml(`<p><a href="javascript:alert(document.domain)">x</a><a href='https://lender.test/t'>terms</a><img src="data:image/png;base64,AAAA" onerror="alert(1)"><a href="data:text/html,<b>">d</a><script>alert(2)</script></p>`);
    expect(out).not.toMatch(/javascript:|onerror|<script|data:text/i);
    expect(out).toContain('href="https://lender.test/t"');
    expect(out).toContain('src="data:image/png;base64,AAAA"');
  });
  it("is served sandboxed, with no scripts allowed", () => {
    expect(TERM_SHEET_VIEW_CSP).toMatch(/^sandbox;/);
    expect(TERM_SHEET_VIEW_CSP).toContain("default-src 'none'");
  });
});
