// BF_SERVER_BLOCK_v456_LENDER_PACKAGE_LINK
import { describe, it, expect, vi, beforeEach } from "vitest";
import fs from "node:fs";

const putMock = vi.fn();
const getMock = vi.fn();
vi.mock("../lib/storage/index.js", () => ({ getStorage: () => ({ put: putMock, get: getMock }) }));
const dbQueryMock = vi.fn();
vi.mock("../db.js", async (orig) => ({ ...(await orig<any>()), dbQuery: (...a: any[]) => dbQueryMock(...a) }));
import { prepareEmailDelivery, shouldLinkPackage, attachLimitBytes, packageLinkEmail } from "../services/lenders/packageLink.js";
const MB = 1024 * 1024;

beforeEach(() => { putMock.mockReset(); getMock.mockReset(); dbQueryMock.mockReset(); delete process.env.LENDER_PACKAGE_ATTACH_MAX_BYTES; });

describe("v456 lender package delivery", () => {
  it("attaches a package at or under 15 MB", async () => {
    expect(attachLimitBytes()).toBe(15 * MB);
    const pool = { query: vi.fn() };
    const d = await prepareEmailDelivery(pool as any, { applicationId: "app", lenderId: "L", lenderName: "Acme", zip: Buffer.alloc(2 * MB), filename: "application-app.zip" });
    expect(d.ok && d.mode).toBe("attached");
    expect(d.ok && d.attachments?.[0]?.filename).toBe("application-app.zip");
    expect(putMock).not.toHaveBeenCalled(); expect(pool.query).not.toHaveBeenCalled();
  });
  it("stores a large package and emails a link instead of attaching it", async () => {
    putMock.mockResolvedValue({ blobName: "lender-packages/app/x.zip", url: "u", hash: "h", sizeBytes: 40 * MB });
    const pool = { query: vi.fn().mockResolvedValue({ rows: [] }) };
    const d = await prepareEmailDelivery(pool as any, { applicationId: "app", lenderId: "L", lenderName: "Acme", zip: Buffer.alloc(40 * MB), filename: "application-app.zip" });
    expect(d.ok && d.mode).toBe("link"); expect(d.ok && d.attachments).toBeUndefined();
    expect(d.ok && d.bodyHtml).toMatch(/https:\/\/server\.boreal\.financial\/api\/public\/lender-package\/[A-Za-z0-9_-]{32}/);
    expect(d.ok && d.bodyText).toContain("40.0 MB");
    expect(putMock.mock.calls[0][0]).toMatchObject({ contentType: "application/zip", pathPrefix: "lender-packages/app" });
    expect(pool.query.mock.calls[0][0]).toContain("INSERT INTO lender_package_links");
  });
  it("reports storage failures", async () => {
    putMock.mockRejectedValue(new Error("container missing"));
    const d = await prepareEmailDelivery({ query: vi.fn() } as any, { applicationId: "app", lenderId: "L", lenderName: "Acme", zip: Buffer.alloc(20 * MB), filename: "a.zip" });
    expect(d).toEqual({ ok: false, error: "package_link_failed: container missing" });
  });
  it("supports env tuning and escapes HTML", () => {
    process.env.LENDER_PACKAGE_ATTACH_MAX_BYTES = String(5 * MB);
    expect(shouldLinkPackage(6 * MB)).toBe(true); expect(shouldLinkPackage(4 * MB)).toBe(false);
    const e = packageLinkEmail({ lenderName: "A<b>", applicationId: "app", url: "https://x/y", expiresAt: new Date("2026-10-24"), sizeBytes: MB });
    expect(e.bodyHtml).toContain("A&lt;b&gt;"); expect(e.bodyText).toContain("2026-10-24");
  });
  it("wires dispatch and provides an idempotent migration", () => {
    expect(fs.readFileSync("src/services/lenders/dispatchToSelected.ts", "utf8")).toContain("await prepareEmailDelivery(ctx.pool");
    const sql = fs.readFileSync("migrations/2026_09_24_v456_lender_package_links.sql", "utf8");
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS"); expect(sql).toContain("CREATE INDEX IF NOT EXISTS");
  });
});

describe("v456 public download route", () => {
  async function app() { const express = (await import("express")).default; const router = (await import("../routes/public.js")).default; const a = express(); a.use("/api/public", router); return a; }
  const token = "A".repeat(32);
  it("serves the zip and counts the download", async () => {
    const request = (await import("supertest")).default;
    dbQueryMock.mockResolvedValueOnce({ rows: [{ blob_name: "b", filename: "application-app.zip", expires_at: new Date(Date.now() + 86_400_000).toISOString() }] }).mockResolvedValueOnce({ rows: [] });
    getMock.mockResolvedValue({ buffer: Buffer.from("zipbytes"), contentType: "application/zip" });
    const res = await request(await app()).get(`/api/public/lender-package/${token}`);
    expect(res.status).toBe(200); expect(res.headers["content-disposition"]).toBe('attachment; filename="application-app.zip"');
    expect(dbQueryMock.mock.calls[1][0]).toContain("download_count = download_count + 1");
  });
  it("rejects expired, unknown, and malformed links", async () => {
    const request = (await import("supertest")).default;
    dbQueryMock.mockResolvedValueOnce({ rows: [{ blob_name: "b", filename: "a.zip", expires_at: new Date(Date.now() - 1000).toISOString() }] });
    expect((await request(await app()).get(`/api/public/lender-package/${token}`)).status).toBe(410);
    dbQueryMock.mockResolvedValueOnce({ rows: [] });
    expect((await request(await app()).get(`/api/public/lender-package/${token}`)).status).toBe(404);
    expect((await request(await app()).get(`/api/public/lender-package/bad!token`)).status).toBe(404);
  });
});
