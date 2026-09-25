// BF_SERVER_BLOCK_v513_LARGE_EMAIL_ATTACHMENTS
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

vi.mock("../db.js", () => ({ pool: { query: vi.fn() } }));
import { base64Size, needsUploadPath, INLINE_ATTACHMENT_LIMIT } from "../routes/o365.js";

const route = readFileSync(fileURLToPath(new URL("../routes/o365.ts", import.meta.url)), "utf-8");
const app = readFileSync(fileURLToPath(new URL("../app.ts", import.meta.url)), "utf-8");

const b64Of = (bytes: number) => Buffer.alloc(bytes, 7).toString("base64");

describe("v513 large email attachments", () => {
  it("measures decoded size from base64", () => {
    expect(base64Size(b64Of(1))).toBe(1);
    expect(base64Size(b64Of(2))).toBe(2);
    expect(base64Size(b64Of(1000))).toBe(1000);
  });
  it("small files send inline; a file over 3 MB uses the upload path", () => {
    expect(needsUploadPath([{ name: "a.pdf", contentType: "application/pdf", contentBytes: b64Of(500_000) }])).toBe(false);
    expect(needsUploadPath([{ name: "b.pdf", contentType: "application/pdf", contentBytes: b64Of(INLINE_ATTACHMENT_LIMIT + 1) }])).toBe(true);
  });
  it("route caps at 25 MB, drafts + uploads when needed, and the send route accepts large bodies", () => {
    expect(route).toContain('error: "attachments_too_large"');
    expect(route).toContain("attachments/createUploadSession");
    expect(route).toContain("await graph.fetch(`${msgPath}/send`");
    expect(app).toContain('app.use("/api/o365/mail/send", express.json({ limit: "50mb" }));');
  });
});
