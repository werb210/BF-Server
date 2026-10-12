// BF_SERVER_BLOCK_v561
import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";
import { answerBySql } from "../../__tests__/helpers/answerBySql.js";
import { __clearPgiStageCache, pgiDone, pgiStageFor } from "../pgiStage.js";

const APP = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const OWNER = "+15875550123";
const h = vi.hoisted(() => ({ query: vi.fn(), outstanding: vi.fn() }));
vi.mock("../../db.js", async (orig) => {
  const real: any = await orig();
  const q = (sql: unknown, params?: unknown[]) => h.query(sql, params);
  const pool = { query: q, connect: async () => ({ query: q, release: () => undefined }) };
  return { ...real, dbQuery: q, runQuery: q, query: q, pool, db: pool, default: pool };
});
vi.mock("../../routes/clientDocumentsNeeded.js", async (orig) => ({ ...(await orig<any>()), computeOutstandingDocs: (id: string) => h.outstanding(id) }));
vi.mock("../termSheetSigned.js", async (orig) => ({ ...(await orig<any>()), termSheetSigned: async () => true }));

beforeEach(() => __clearPgiStageCache());

describe("v561 PGI prompt", () => {
  it("is done once the PGI application has moved past new_application", () => {
    expect(pgiDone(null)).toBe(false);
    expect(pgiDone("new_application")).toBe(false);
    expect(pgiDone("documents_pending")).toBe(true);
    expect(pgiDone("policy_issued")).toBe(true);
  });
  it("looks the stage up once per 5 minutes and treats failures as not done", async () => {
    const fetchStage = vi.fn(async () => "under_review");
    const deps = { biPublicId: async () => "BI-1", fetchStage, now: () => 1000 };
    expect(await pgiStageFor("a1", deps)).toBe("under_review");
    await pgiStageFor("a1", deps);
    expect(fetchStage).toHaveBeenCalledTimes(1);
    expect(await pgiStageFor("a2", { ...deps, fetchStage: async () => { throw new Error("down"); } })).toBeNull();
    expect(await pgiStageFor("a3", { ...deps, biPublicId: async () => null })).toBeNull();
  });
});

describe("v561 client thread", () => {
  const ROWS = [
    { id: "note1", direction: "outbound", body: "We've added more documents to your checklist: void cheque", staff_name: null, cta_label: null, cta_action: null, created_at: "2026-10-01T00:00:00Z" },
    { id: "note2", direction: "outbound", body: "To continue your application, please upload your bank statements", staff_name: null, cta_label: null, cta_action: null, created_at: "2026-10-01T00:01:00Z" },
    { id: "docs", direction: "outbound", body: "Upload your documents", staff_name: null, cta_label: "Upload documents", cta_action: "upload_docs", created_at: "2026-10-01T00:02:00Z" },
    { id: "pgi", direction: "outbound", body: "PGI", staff_name: null, cta_label: "Complete PGI Application", cta_action: "https://pgi.example/a", created_at: "2026-10-01T00:03:00Z" },
    { id: "chat", direction: "outbound", body: "Thanks Dana, your file is with the lender.", staff_name: "Todd", cta_label: null, cta_action: null, created_at: "2026-10-01T00:04:00Z" },
  ];
  async function thread() {
    const app = express();
    app.use(express.json());
    const { default: clientRouter } = await import("../../routes/client/index.js");
    app.use("/api/client", clientRouter);
    const token = "Bearer " + jwt.sign({ sub: "client:" + OWNER, role: "client", phone: OWNER, isClient: true }, process.env.JWT_SECRET as string, { algorithm: "HS256" });
    const r = await request(app).get(`/api/client/messages?applicationId=${APP}`).set("Authorization", token);
    expect(r.status).toBe(200);
    return (r.body.data as Array<{ id: string }>).map((m) => m.id);
  }
  beforeEach(() => {
    h.query.mockReset();
    h.query.mockImplementation(answerBySql([
      [/FROM applications WHERE lower\(id::text\) = ANY/, { rows: [{ id: APP }] }],
      [/WITH app_phones AS/, { rows: [{ total: 1, mine: 1, known: 1 }] }],
      [/WITH thread AS/, { rows: ROWS }],
    ]));
    h.outstanding.mockReset();
  });

  it("decides 'documents all in' from the live upload list", async () => {
    h.outstanding.mockResolvedValue({ required: [{ document_type: "bank" }], stillNeeded: [], rejected: [] });
    expect(await thread()).toEqual(["chat"]);
    expect(h.outstanding).toHaveBeenCalledWith(APP);
  }, 30_000);

  it("a failed upload-list read is logged and the conversation still loads", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    h.outstanding.mockRejectedValue(new Error("docs table down"));
    expect(await thread()).toEqual(["chat"]);
    expect(warn.mock.calls.some((c) => c[0] === "[client/messages] outstanding_docs_failed" && (c[1] as any)?.applicationId === APP)).toBe(true);
    warn.mockRestore();
  }, 30_000);

  it("drops finished checklist notes and the finished PGI prompt", async () => {
    h.outstanding.mockResolvedValue({ required: [], stillNeeded: [], rejected: [] });
    const ids = await thread();
    for (const gone of ["note1", "note2", "docs", "pgi"]) expect(ids).not.toContain(gone);
    expect(ids).toEqual(["chat"]);
  }, 30_000);
});
