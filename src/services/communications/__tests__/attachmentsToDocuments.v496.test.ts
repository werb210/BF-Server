// BF_SERVER_BLOCK_v496_MESSAGE_ATTACHMENTS_TO_DOCUMENTS
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";
import { answerBySql } from "../../../__tests__/helpers/answerBySql.js";

const APP = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const OWNER = "+15875550123";
const ROUTES = answerBySql([
  [/FROM applications WHERE lower\(id::text\) = ANY/, { rows: [{ id: APP }] }],
  [/WITH app_phones AS/, { rows: [{ total: 1, mine: 1, known: 1 }] }],
  [/SELECT id, email, role, silo, silos FROM users WHERE id = \$1/, { rows: [{ id: "99999999-9999-4999-8999-999999999999", email: "todd@boreal.financial", role: "Admin", silo: "BF" }] }],
]);
const { persistAndEnqueue, query } = vi.hoisted(() => ({ persistAndEnqueue: vi.fn(), query: vi.fn() }));
vi.mock("../../../routes/documents.js", async (orig) => ({ ...(await orig<any>()), persistAndEnqueue }));
vi.mock("../../../db.js", async (orig) => {
  const real: any = await orig();
  const q = (sql: unknown, params?: unknown[]) => query(sql, params);
  const pool = { query: q, connect: async () => ({ query: q, release: () => undefined }) };
  return { ...real, dbQuery: q, runQuery: q, query: q, pool, db: pool, default: pool };
});

import { decodeDataUrl, saveMessageAttachmentsAsDocuments } from "../attachmentsToDocuments.js";
import clientRouter from "../../../routes/client/index.js";
import communications from "../../../routes/communications.js";

const pdf = `data:application/pdf;base64,${Buffer.from("%PDF-1.4 test").toString("base64")}`;

describe("v496 message attachments become documents", () => {
  beforeEach(() => {
    persistAndEnqueue.mockReset();
    query.mockReset();
    query.mockImplementation(ROUTES);
  });

  it("decodes base64 and plain data URLs", () => {
    expect(decodeDataUrl(pdf)?.toString()).toBe("%PDF-1.4 test");
    expect(decodeDataUrl("data:text/plain,hello%20there")?.toString()).toBe("hello there");
    expect(decodeDataUrl("not a data url")).toBeNull();
  });

  it("files each attachment as an Other document and links it back", async () => {
    // BF_SERVER_v789_SQL_CONTENT_MOCKS - answer the document insert by what is filed, not by call order.
    persistAndEnqueue.mockImplementation(async (input: { applicationId: string }) => (input.applicationId === "a1" ? { id: "doc-1" } : null));
    const out = await saveMessageAttachmentsAsDocuments({ messageId: "m1", applicationId: "a1", uploadedBy: "client",
      attachments: [{ name: "statement.pdf", contentType: "application/pdf", dataUrl: pdf }] });
    expect(persistAndEnqueue).toHaveBeenCalledWith(expect.objectContaining({ applicationId: "a1", category: "Other", uploadedBy: "client" }));
    expect(out[0].documentId).toBe("doc-1");
    expect(query).toHaveBeenCalledWith(expect.stringContaining("UPDATE communications_messages SET attachments"), ["m1", expect.any(String)]);
  });

  it("links a duplicate to the existing document instead of failing", async () => {
    persistAndEnqueue.mockRejectedValue(Object.assign(new Error("dup"), { name: "DuplicateDocumentError", existing: { id: "doc-old" } }));
    const out = await saveMessageAttachmentsAsDocuments({ messageId: "m2", applicationId: "a1", uploadedBy: "client",
      attachments: [{ name: "statement.pdf", contentType: "application/pdf", dataUrl: pdf }] });
    expect(out[0].documentId).toBe("doc-old");
  });

  it("both message routes hand attachments to the saver", async () => {
    persistAndEnqueue.mockImplementation(async () => ({ id: "doc-new" }));
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const app = express();
    app.use(express.json({ limit: "10mb" }));
    app.use("/api/client", clientRouter);
    app.use("/api/communications", communications);
    const attachments = [{ name: "statement.pdf", contentType: "application/pdf", dataUrl: pdf }];

    const client = "Bearer " + jwt.sign({ sub: "client:" + OWNER, role: "client", phone: OWNER, isClient: true }, process.env.JWT_SECRET as string, { algorithm: "HS256" });
    const c = await request(app).post("/api/client/messages").set("Authorization", client).send({ applicationId: APP, body: "Here you go", attachments });
    expect(c.status).toBe(201);
    await vi.waitFor(() => expect(persistAndEnqueue).toHaveBeenCalledWith(expect.objectContaining({ applicationId: APP, uploadedBy: "client" })));

    persistAndEnqueue.mockClear();
    const staff = "Bearer " + jwt.sign({ sub: "99999999-9999-4999-8999-999999999999", role: "Admin", tokenVersion: 0, tv: 0 }, process.env.JWT_SECRET as string);
    const s = await request(app).post("/api/communications/messages/send").set("Authorization", staff).send({ applicationId: APP, body: "Received, thanks", attachments });
    expect(s.status).toBeLessThan(300);
    await vi.waitFor(() => expect(persistAndEnqueue).toHaveBeenCalledTimes(1));
    const staffCall = persistAndEnqueue.mock.calls[0]![0] as { applicationId: string; uploadedBy: string };
    expect(staffCall.applicationId).toBe(APP);
    expect(staffCall.uploadedBy).toMatch(/^staff:/);
    expect(staffCall.uploadedBy).not.toBe("staff:unknown");
  });
});
