// BF_SERVER_UPLOAD_DIAG_v751 / BF_SERVER_QUIET_ACTION_CENTER_v751
import { describe, it, expect, vi } from "vitest";
import { EventEmitter } from "node:events";
import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";
import { answerBySql } from "./helpers/answerBySql.js";

const APP = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const OWNER = "+15875550123";
const h = vi.hoisted(() => ({ counts: { outstanding: 2, completed: 1 }, logInfo: vi.fn() }));
vi.mock("../db.js", async (orig) => {
  const real: any = await orig();
  // APP exists and is claimed by OWNER: the client ownership guard refuses anyone else.
  const q = (sql: unknown, params?: unknown[]) => answerBySql([
    [/FROM applications WHERE lower\(id::text\) = ANY/, { rows: [{ id: APP }] }],
    [/SELECT COUNT\(\*\)::text AS n FROM app_phones/, (_s: string, p?: unknown[]) => ({ rows: [{ n: p?.[1] === OWNER.slice(-10) ? "1" : "0" }] })],
    [/WITH app_phones AS/, (_s: string, p?: unknown[]) => ({ rows: [{ total: 1, mine: p?.[1] === OWNER.slice(-10) ? 1 : 0, known: 1 }] })],
  ])(sql, params);
  const pool = { query: q, connect: async () => ({ query: q, release: () => undefined }) };
  return { ...real, dbQuery: q, runQuery: q, query: q, pool, db: pool, default: pool };
});
vi.mock("../services/applicantActions.js", async (orig) => ({
  ...(await orig<any>()),
  buildActionCenter: async () => ({ outstanding: [], completed: Array(h.counts.completed).fill({}), outstandingCount: h.counts.outstanding }),
}));
vi.mock("../observability/logger.js", async (orig) => ({ ...(await orig<any>()), logInfo: h.logInfo }));

import { uploadTiming } from "../middleware/uploadTiming.js";
import { sanitizeUploadFailure } from "../routes/client/uploadFailure.js";
import clientRouter from "../routes/client/index.js";
import documentsRouter from "../routes/documents.js";
import documentsNeeded from "../routes/clientDocumentsNeeded.js";

function fakeRes(statusCode = 201) { const r: any = new EventEmitter(); r.statusCode = statusCode; return r; }

describe("upload timing log", () => {
  it("logs status, time and size when the upload finishes", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const res = fakeRes(201); const next = vi.fn();
    uploadTiming({ headers: { "content-length": "2048" } } as any, res, next);
    expect(next).toHaveBeenCalled();
    res.emit("finish"); res.emit("close");
    expect(log.mock.calls.map((c) => String(c[0])).join("\n")).toMatch(/\[client-upload\] \{"status":201,"ms":\d+,"bytes":2048\}/);
    log.mockRestore();
  });
  it("says aborted when the browser drops the connection first", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const res = fakeRes();
    uploadTiming({ headers: {} } as any, res, () => undefined);
    res.emit("close");
    expect(String(warn.mock.calls[0]?.[0])).toMatch(/\[client-upload\] \{"aborted":true,"ms":\d+,"bytes":null\}/);
    warn.mockRestore();
  });
  it("sits in front of the client upload route", async () => {
    // A refused upload is timed too: the timing middleware runs before the sign-in check.
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const app = express();
    app.use("/api/documents", documentsRouter);
    const r = await request(app).post("/api/documents/upload").set("Content-Type", "application/octet-stream").send(Buffer.alloc(16));
    expect(r.status).toBe(401);
    await vi.waitFor(() => expect(log.mock.calls.map((c) => String(c[0])).join("\n")).toMatch(/\[client-upload\] {"status":401,"ms":\d+,"bytes":16\}/));
    log.mockRestore();
  });
});

describe("upload-failure beacon", () => {
  it("keeps only safe, bounded fields", () => {
    const out = sanitizeUploadFailure({ applicationId: "724506b6-24bb-4054-a45d-964370564953", documentType: "owner_photo_id", status: 0, errorName: "TypeError",
      errorMessage: "Failed to fetch", sizeBytes: 123456.7, contentType: "application/pdf", ms: 31000, online: true, attempt: "direct", filename: "secret.pdf", phone: "555" });
    expect(out).toEqual({ applicationId: "724506b6-24bb-4054-a45d-964370564953", documentType: "owner_photo_id", status: 0, errorName: "TypeError",
      errorMessage: "Failed to fetch", sizeBytes: 123457, contentType: "application/pdf", ms: 31000, online: true, attempt: "direct" });
    expect(sanitizeUploadFailure({ applicationId: "x; drop", documentType: "<script>" })).toMatchObject({ applicationId: null, documentType: null });
  });
  it("is mounted before the client ownership checks", async () => {
    // A failed upload from a phone whose session expired must still be reported.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const app = express();
    app.use(express.json());
    app.use("/api/client", clientRouter);
    const r = await request(app).post("/api/client/upload-failure").send({ applicationId: APP, documentType: "owner_photo_id", status: 0 });
    expect(r.status).toBe(204);
    expect(warn.mock.calls.some((c) => String(c[0]).startsWith("[client-upload-failure] ") && String(c[0]).includes(APP))).toBe(true);
    // The same unsigned request to a guarded client route is refused.
    expect((await request(app).post("/api/client/messages").send({ applicationId: APP, body: "x" })).status).toBe(401);
    warn.mockRestore();
  });
});

describe("quiet action-center log", () => {
  it("logs only when an application's counts change", async () => {
    const app = express();
    app.use("/api/client/documents-needed", documentsNeeded);
    const token = "Bearer " + jwt.sign({ sub: "client:" + OWNER, role: "client", phone: OWNER, isClient: true }, process.env.JWT_SECRET as string, { algorithm: "HS256" });
    const poll = () => request(app).get(`/api/client/documents-needed/action-center?applicationId=${APP}`).set("Authorization", token);
    const built = () => h.logInfo.mock.calls.filter((c) => c[0] === "action_center_built");
    h.logInfo.mockClear();
    h.counts = { outstanding: 2, completed: 1 };
    for (let i = 0; i < 3; i += 1) expect((await poll()).status).toBe(200);
    expect(built()).toHaveLength(1);
    expect(built()[0]![1]).toEqual({ applicationId: APP, outstanding: 2, completed: 1 });
    h.counts = { outstanding: 1, completed: 2 };
    await poll();
    await poll();
    expect(built()).toHaveLength(2);
    expect(built()[1]![1]).toEqual({ applicationId: APP, outstanding: 1, completed: 2 });
  });
});
