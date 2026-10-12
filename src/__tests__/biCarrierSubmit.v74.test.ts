// BF_SERVER_BI_CARRIER_v74 - accepting a term sheet fired a SignNow envelope
// and nothing else, so the PGI application never reached the carrier without
// somebody remembering to do it by hand.
import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";
import { answerBySql, type SqlRule } from "./helpers/answerBySql.js";

const h = vi.hoisted(() => ({
  query: vi.fn(),
  logError: vi.fn(),
  logInfo: vi.fn(),
  stubCarrier: null as null | ((id: string) => Promise<unknown>),
}));
vi.mock("../db.js", async (orig) => ({ ...(await orig() as any), pool: { query: h.query, connect: vi.fn() }, runQuery: h.query, dbQuery: h.query }));
vi.mock("../observability/logger.js", async (orig) => ({
  ...(await orig() as any),
  logError: (...a: unknown[]) => h.logError(...a),
  logInfo: (...a: unknown[]) => h.logInfo(...a),
}));
vi.mock("../services/biCarrierSubmit.js", async (orig) => {
  const real: any = await orig();
  return { ...real, submitBiToCarrier: (id: string) => (h.stubCarrier ? h.stubCarrier(id) : real.submitBiToCarrier(id)) };
});
import { submitBiToCarrier } from "../services/biCarrierSubmit.js";
import { mirrorDocToBi } from "../services/biDocMirror.js";
import offerAcceptance from "../routes/offerAcceptance.js";

type Call = { url: string; init: RequestInit };
let calls: Call[] = [];
function stubBi(submit: (url: string, init: RequestInit) => Promise<Response> | Response) {
  calls = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url: String(url), init });
    if (String(url).includes("/pgi-readiness")) return new Response(JSON.stringify({ ok: true, result: { applicationId: "bi-77" } }), { status: 200 });
    return submit(String(url), init);
  }));
}
const bearer = (c: Call) => jwt.decode(String(new Headers(c.init.headers).get("authorization")).slice(7)) as Record<string, unknown>;
function answer(rules: SqlRule[]) { h.query.mockImplementation(answerBySql(rules)); }

beforeEach(() => {
  h.query.mockReset();
  answer([[/SELECT bi_public_id FROM applications/, { rows: [{ bi_public_id: "pub-1" }] }]]);
  h.logError.mockReset();
  h.logInfo.mockReset();
  h.stubCarrier = null;
});
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); vi.restoreAllMocks(); });

describe("it calls bi-server rather than reimplementing the carrier", () => {
  it("hits the endpoint that owns dispatch", async () => {
    stubBi(() => new Response(JSON.stringify({ status: "submitted", externalId: "PGI-1" }), { status: 200 }));
    expect(await submitBiToCarrier("bf-1")).toEqual({ ok: true, externalId: "PGI-1", status: "submitted" });
    const submit = calls.find((c) => c.url.endsWith("/submit-pgi"))!;
    expect(submit.url).toMatch(/\/api\/v1\/bi\/application\/bi-77\/submit-pgi$/);
    expect(submit.init.method).toBe("POST");
  });

  it("uses the same service-JWT pattern as the document mirror", async () => {
    stubBi(() => new Response("{}", { status: 200 }));
    await submitBiToCarrier("bf-1");
    const carrier = bearer(calls.find((c) => c.url.endsWith("/submit-pgi"))!);
    // BF_SERVER_v784_BI_CARRIER - BI accepts kind service / service bf-server.
    expect(carrier).toMatchObject({ kind: "service", source: "bf-server", service: "bf-server", iss: "bf-server", aud: "bi-server" });

    calls = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => { calls.push({ url: String(url), init }); return new Response(JSON.stringify({ ok: true, bi_document_id: "d" }), { status: 200 }); }));
    await mirrorDocToBi({ bfApplicationId: "bf-1", bfDocumentId: "doc-1", documentType: "A/R", fileName: "a.pdf", mimeType: null, fileSize: 1, storageUrl: "u", uploadedByName: null } as any);
    const mirror = bearer(calls[0]);
    expect(mirror).toMatchObject({ kind: "service", source: "bf-server", iss: "bf-server", aud: "bi-server" });
  });
});

describe("no PGI is not an error", () => {
  it("skips when the applicant declined at Step 6, deciding from bi_public_id", async () => {
    answer([[/SELECT bi_public_id FROM applications/, { rows: [{ bi_public_id: null }] }]]);
    stubBi(() => new Response("{}", { status: 200 }));
    expect(await submitBiToCarrier("bf-2")).toEqual({ ok: true, skipped: "no_pgi" });
    expect(calls).toEqual([]);
    expect(h.query.mock.calls[0][1]).toEqual(["bf-2"]);
  });
});

describe("it cannot break an acceptance", () => {
  const staff = "Bearer " + jwt.sign({ sub: "75757575-7575-4575-8575-757575757575", role: "Staff", tokenVersion: 0, tv: 0 }, process.env.JWT_SECRET as string);
  const app = express();
  app.use(express.json());
  app.use("/api/offers", offerAcceptance);
  const confirm = () => request(app).post("/api/offers/off-1/confirm-acceptance").set("Authorization", staff).send({ fundedAmount: 50000, fundedCurrency: "CAD" });
  const accepted = (applicationId: string | null) =>
    answer([[/UPDATE offers\s+SET status = 'accepted'/, { rows: [{ id: "off-1", application_id: applicationId, status: "accepted" }] }]]);

  it("is fire and forget: a hung carrier call does not hold the response", async () => {
    accepted("app-1");
    const seen: string[] = [];
    h.stubCarrier = (id) => { seen.push(id); return new Promise(() => undefined); };
    const r = await confirm();
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, offer: { id: "off-1" } });
    await vi.waitFor(() => expect(seen).toEqual(["app-1"]));
  });

  it("a failed carrier call is logged, and the acceptance still succeeds", async () => {
    accepted("app-1");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    h.stubCarrier = async () => { throw new Error("bi unreachable"); };
    const r = await confirm();
    expect(r.status).toBe(200);
    await vi.waitFor(() => expect(warn).toHaveBeenCalledWith("[offer] BI carrier submit failed", "Error: bi unreachable"));
  });

  it("only fires when there is an application", async () => {
    accepted(null);
    const seen: string[] = [];
    h.stubCarrier = async (id) => { seen.push(id); return { ok: true }; };
    expect((await confirm()).status).toBe(200);
    await new Promise((r) => setTimeout(r, 20));
    expect(seen).toEqual([]);
  });
});

describe("a rejection is visible", () => {
  it("logs when bi-server refuses, rather than swallowing it", async () => {
    stubBi(() => new Response("docs not ready", { status: 422 }));
    expect(await submitBiToCarrier("bf-1")).toEqual({ ok: false, reason: "bi_422" });
    expect(h.logError).toHaveBeenCalledWith("bi_carrier_submit_rejected", expect.objectContaining({ bfApplicationId: "bf-1", status: 422, body: "docs not ready" }));
  });

  it("logs the success too, so the trail exists", async () => {
    stubBi(() => new Response(JSON.stringify({ status: "submitted" }), { status: 200 }));
    await submitBiToCarrier("bf-1");
    expect(h.logInfo).toHaveBeenCalledWith("bi_carrier_submitted", expect.objectContaining({ bfApplicationId: "bf-1", status: "submitted" }));
  });

  it("times out rather than hanging the process", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    stubBi((_url, init) => new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => reject(new Error("aborted")));
    }));
    const pending = submitBiToCarrier("bf-1");
    await vi.advanceTimersByTimeAsync(15_000);
    expect(await pending).toEqual({ ok: false, reason: "request_failed" });
    expect(h.logError).toHaveBeenCalledWith("bi_carrier_submit_failed", expect.objectContaining({ error: "Error: aborted" }));
  });
});
