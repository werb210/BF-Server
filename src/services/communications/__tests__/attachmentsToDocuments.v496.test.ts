// BF_SERVER_BLOCK_v496_MESSAGE_ATTACHMENTS_TO_DOCUMENTS
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const { persistAndEnqueue, query } = vi.hoisted(() => ({ persistAndEnqueue: vi.fn(), query: vi.fn(async () => ({ rows: [] })) }));
vi.mock("../../../routes/documents.js", () => ({ persistAndEnqueue }));
vi.mock("../../../db.js", () => ({ pool: { query } }));

import { decodeDataUrl, saveMessageAttachmentsAsDocuments } from "../attachmentsToDocuments.js";

const pdf = `data:application/pdf;base64,${Buffer.from("%PDF-1.4 test").toString("base64")}`;

describe("v496 message attachments become documents", () => {
  beforeEach(() => { persistAndEnqueue.mockReset(); query.mockClear(); });

  it("decodes base64 and plain data URLs", () => {
    expect(decodeDataUrl(pdf)?.toString()).toBe("%PDF-1.4 test");
    expect(decodeDataUrl("data:text/plain,hello%20there")?.toString()).toBe("hello there");
    expect(decodeDataUrl("not a data url")).toBeNull();
  });

  it("files each attachment as an Other document and links it back", async () => {
    persistAndEnqueue.mockResolvedValueOnce({ id: "doc-1" });
    const out = await saveMessageAttachmentsAsDocuments({ messageId: "m1", applicationId: "a1", uploadedBy: "client",
      attachments: [{ name: "statement.pdf", contentType: "application/pdf", dataUrl: pdf }] });
    expect(persistAndEnqueue).toHaveBeenCalledWith(expect.objectContaining({ applicationId: "a1", category: "Other", uploadedBy: "client" }));
    expect(out[0].documentId).toBe("doc-1");
    expect(query).toHaveBeenCalledWith(expect.stringContaining("UPDATE communications_messages SET attachments"), ["m1", expect.any(String)]);
  });

  it("links a duplicate to the existing document instead of failing", async () => {
    persistAndEnqueue.mockRejectedValueOnce(Object.assign(new Error("dup"), { name: "DuplicateDocumentError", existing: { id: "doc-old" } }));
    const out = await saveMessageAttachmentsAsDocuments({ messageId: "m2", applicationId: "a1", uploadedBy: "client",
      attachments: [{ name: "statement.pdf", contentType: "application/pdf", dataUrl: pdf }] });
    expect(out[0].documentId).toBe("doc-old");
  });

  it("both message routes hand attachments to the saver", () => {
    const staff = readFileSync(fileURLToPath(new URL("../../../routes/communications.ts", import.meta.url)), "utf-8");
    const client = readFileSync(fileURLToPath(new URL("../../../routes/client/index.ts", import.meta.url)), "utf-8");
    expect(staff).toContain("uploadedBy: `staff:${staffName ?? \"unknown\"}`");
    expect(client).toContain('uploadedBy: "client"');
  });
});
