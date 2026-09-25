// BF_SERVER_BLOCK_v504_TEAM_LINK_PREVIEWS
import { describe, it, expect, vi } from "vitest";
vi.mock("../../db.js", () => ({ pool: { query: vi.fn(async () => ({ rows: [] })) } }));
import { isPublicAddress, parsePreview, fetchPreview } from "../linkPreview.js";

describe("v504 link previews", () => {
  it("refuses private, loopback, link-local and metadata addresses", () => {
    for (const ip of ["10.0.0.1", "127.0.0.1", "169.254.169.254", "172.16.5.4", "192.168.1.1", "100.64.0.1", "::1", "fd00::1", "fe80::1", "::ffff:10.0.0.1"]) {
      expect(isPublicAddress(ip)).toBe(false);
    }
    expect(isPublicAddress("8.8.8.8")).toBe(true);
    expect(isPublicAddress("2606:4700::1111")).toBe(true);
  });

  it("reads Open Graph tags and falls back to <title>", () => {
    const html = `<html><head><title>Fallback</title><meta property="og:title" content="Boreal &amp; Co"><meta name="description" content="Business financing"><meta property="og:image" content="/img/card.png"></head></html>`;
    const p = parsePreview("https://boreal.financial/page", html);
    expect(p.title).toBe("Boreal & Co");
    expect(p.description).toBe("Business financing");
    expect(p.imageUrl).toBe("https://boreal.financial/img/card.png");
    expect(parsePreview("https://x.example/", "<title>Only title</title>").title).toBe("Only title");
  });

  it("will not fetch an internal address", async () => {
    await expect(fetchPreview("http://169.254.169.254/latest/meta-data")).rejects.toThrow("address_not_public");
    await expect(fetchPreview("ftp://example.com/")).rejects.toThrow("scheme_not_allowed");
  });
});
