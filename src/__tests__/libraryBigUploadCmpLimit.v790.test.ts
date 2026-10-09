// BF_SERVER_LIBRARY_BIG_UPLOAD_v790 / BF_SERVER_CMP_READ_LIMIT_v790 / BF_SERVER_SBA_OWNER1_EMAIL_v790
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import { readFileSync } from "node:fs";

vi.mock("../middleware/auth.js", () => ({ requireAuth: (req: any, _res: any, next: any) => { req.user = { id: "u1", role: "Staff" }; next(); } }));
vi.mock("../db.js", () => ({ pool: { query: async (sql: string) => sql.includes("FROM staff_library") ? { rows: [{ drive_id: "D1", item_id: "ROOT", share_url: "https://share/lib" }] } : { rows: [] } } }));
vi.mock("../modules/o365/graphClient.js", () => ({
  getGraphForUser: async () => ({
    accessToken: "t",
    fetch: async (path: string) => path.includes("/createUploadSession")
      ? new Response(JSON.stringify({ uploadUrl: "https://boreal-my.sharepoint.com/upload/abc" }), { status: 200 })
      : new Response("{}", { status: 200 }),
  }),
}));
import o365, { isOneDriveUploadUrl, LIBRARY_CHUNK_BYTES } from "../routes/o365.js";

const app = express();
app.use(express.json({ limit: "10mb" }));
app.use("/api/o365", o365);
const MB = 1024 * 1024;

beforeEach(() => { vi.restoreAllMocks(); });

describe("Staff Library uploads up to 200 MB", () => {
  it("opens a OneDrive upload session for a 150 MB file", async () => {
    const r = await request(app).post("/api/o365/library/upload-session").send({ name: "Boreal Staff Portal Setup 1.0.1.exe", size: 150 * MB });
    expect(r.status).toBe(200);
    expect(r.body.uploadUrl).toBe("https://boreal-my.sharepoint.com/upload/abc");
    expect(r.body.chunkBytes % (320 * 1024)).toBe(0);
    expect(r.body.maxBytes).toBe(200 * MB);
  });
  it("refuses over 200 MB with a clear message", async () => {
    const r = await request(app).post("/api/o365/library/upload-session").send({ name: "big.exe", size: 200 * MB + 1 });
    expect(r.status).toBe(413);
    expect(r.body.message).toContain("200 MB");
  });
  it("passes each piece straight to OneDrive with the right byte range", async () => {
    const put = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 202 }));
    const piece = Buffer.alloc(LIBRARY_CHUNK_BYTES, 1);
    const r = await request(app).post("/api/o365/library/upload-chunk")
      .set("Content-Type", "application/octet-stream")
      .set("x-upload-url", "https://boreal-my.sharepoint.com/upload/abc")
      .set("x-chunk-start", "0").set("x-total-size", String(12 * MB))
      .send(piece);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ done: false, next: LIBRARY_CHUNK_BYTES });
    expect((put.mock.calls[0]![1] as any).headers["Content-Range"]).toBe("bytes 0-" + (LIBRARY_CHUNK_BYTES - 1) + "/" + 12 * MB);
  });
  it("returns the file once the last piece lands", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ id: "X1", name: "Setup.exe", webUrl: "https://od/X1", size: 10 }), { status: 201 }));
    const r = await request(app).post("/api/o365/library/upload-chunk")
      .set("Content-Type", "application/octet-stream")
      .set("x-upload-url", "https://boreal-my.sharepoint.com/upload/abc")
      .set("x-chunk-start", "0").set("x-total-size", "10")
      .send(Buffer.alloc(10, 1));
    expect(r.body).toMatchObject({ done: true, item: { id: "X1", name: "Setup.exe" } });
  });
  it("never forwards to anything but OneDrive", async () => {
    expect(isOneDriveUploadUrl("https://evil.example.com/x")).toBe(false);
    expect(isOneDriveUploadUrl("http://boreal-my.sharepoint.com/x")).toBe(false);
    const r = await request(app).post("/api/o365/library/upload-chunk")
      .set("Content-Type", "application/octet-stream").set("x-upload-url", "https://169.254.169.254/latest")
      .set("x-chunk-start", "0").set("x-total-size", "1").send(Buffer.alloc(1));
    expect(r.status).toBe(400);
  });
});

describe("the browser is allowed to send upload pieces cross-origin", () => {
  it("CORS allows the three upload headers (staff.boreal.financial -> server.boreal.financial)", () => {
    const a = readFileSync("src/app.ts", "utf8");
    for (const h of ['"x-upload-url"', '"x-chunk-start"', '"x-total-size"']) expect(a).toContain(h);
  });
});

describe("the client portal is not starved by the site-wide limiter", () => {
  const c = readFileSync("src/routes/client/index.ts", "utf8");
  it("client reads have their own per-client ceiling", () => {
    expect(c).not.toContain("clientReadRateLimit()");
    expect(c).toContain('"tok:" + createHash("sha256")');
    expect(c).toContain("limit: 120,");
  });
});

describe("owner 1 is only told to sign when the signing exists", () => {
  it("uses the CRM email for owner 1 before skipping", () => {
    const s = readFileSync("src/signnow/sba/sbaSigning.ts", "utf8");
    const loop = s.slice(s.indexOf("for (const owner of owners) {"));
    expect(loop.indexOf("const signerEmail")).toBeLessThan(loop.indexOf("if (!signerEmail)"));
  });
  it("does not text or email owner 1 when their signing was not created", () => {
    const t = readFileSync("src/signnow/sba/sbaTrigger.ts", "utf8");
    expect(t).toContain("ownerOne?.started ? await notifyOwnerOne(applicationId)");
  });
});
