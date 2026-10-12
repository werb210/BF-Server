// BF_SERVER_LENDER_INGEST_v57 - guards the wiring, because the previous version
// compiled, ran, returned 201, and indexed nothing for months.
import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";
import { answerBySql } from "./helpers/answerBySql.js";

const h = vi.hoisted(() => ({ query: vi.fn(), embedAndStore: vi.fn(), extract: vi.fn(), fetch: vi.fn() }));
vi.mock("../db.js", async (orig) => ({ ...(await orig() as any), pool: { query: h.query, connect: vi.fn() }, runQuery: h.query, dbQuery: h.query }));
vi.mock("../ai/embeddingService.js", () => ({ extractTextFromBuffer: (...a: unknown[]) => h.extract(...a) }));
vi.mock("../modules/ai/knowledge.service.js", () => ({ embedAndStore: (...a: unknown[]) => h.embedAndStore(...a) }));
import lenderSelf from "../routes/lenderSelf.js";

const LENDER_ID = "51515151-5151-4151-8151-515151515151";
const lender = "Bearer " + jwt.sign({ sub: "lender:" + LENDER_ID, role: "Lender", lenderId: LENDER_ID }, process.env.JWT_SECRET as string);
const app = express();
app.use("/api/lender", lenderSelf);
const upload = () => request(app).post("/api/lender/uploads").set("Authorization", lender)
  .attach("file", Buffer.from("%PDF-1.4 fake"), { filename: "deck.pdf", contentType: "application/pdf" });

let errorSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  h.query.mockReset();
  h.query.mockImplementation(answerBySql([[/INSERT INTO lender_documents/, { rows: [{ id: "ld-9", filename: "deck.pdf", mime_type: "application/pdf", created_at: "2026-10-01" }] }]]));
  h.embedAndStore.mockReset();
  h.extract.mockReset();
  h.extract.mockResolvedValue("Equipment financing, 24-60 months.");
  h.fetch.mockReset();
  vi.stubGlobal("fetch", h.fetch);
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => { vi.unstubAllGlobals(); errorSpy.mockRestore(); });

describe("lender uploads train Maya", () => {
  it("calls embedAndStore, the path staff uploads use, on the extracted text", async () => {
    const r = await upload();
    expect(r.status).toBe(201);
    expect(h.extract).toHaveBeenCalledWith(expect.any(Buffer), "application/pdf");
    expect(h.embedAndStore).toHaveBeenCalledWith(expect.anything(), "Equipment financing, 24-60 months.", "lender_document", "ld-9", "deck.pdf");
  });

  it("no longer posts to the non-existent Maya ingest route", async () => {
    await upload();
    expect(h.fetch).not.toHaveBeenCalled();
  });

  it("does not swallow ingest failures silently", async () => {
    h.embedAndStore.mockRejectedValue(Object.assign(new Error("embedding failed"), { code: "openai_429" }));
    const r = await upload();
    expect(r.status).toBe(201); // the document is stored either way
    expect(r.body.data).toMatchObject({ indexed: false, indexError: "openai_429" });
    expect(errorSpy).toHaveBeenCalledWith("[LENDER_UPLOAD][INGEST] failed", expect.objectContaining({ lenderId: LENDER_ID, filename: "deck.pdf", error: "openai_429" }));
  });

  it("tags lender material distinctly in the knowledge base", async () => {
    await upload();
    expect(h.embedAndStore.mock.calls[0][2]).toBe("lender_document");
  });

  it("reports index status to the caller", async () => {
    expect((await upload()).body.data).toMatchObject({ indexed: true, indexError: null });
    h.extract.mockResolvedValue("   ");
    expect((await upload()).body.data).toMatchObject({ indexed: false, indexError: "no_text_extracted" });
  });
});
