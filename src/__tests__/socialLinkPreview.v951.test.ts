// BF_SERVER_v951_SOCIAL_LINK_PREVIEW
import { describe, expect, it, vi } from "vitest";
import { fetchLinkPreview, LinkPreviewError, previewFromHtml } from "../social/linkPreview.js";
import type { HttpClient } from "../lenderConnectors/http.js";

const page = (head: string) => `<!doctype html><html><head>${head}</head><body>x</body></html>`;
const ok = (html: string) => ({ status: 200, headers: { "content-type": "text/html; charset=utf-8" }, text: html });

describe("article picture for a social post", () => {
  it("reads the picture, headline and summary, whatever order the attributes are in", () => {
    const p = previewFromHtml(page(`<meta content="https://cdn.news.example/a.jpg" property="og:image"><meta property='og:title' content='Rates hold &amp; lenders react'><meta name="description" content="Short summary."><meta property="og:site_name" content="Example News">`), "https://news.example/story");
    expect(p).toEqual({ url: "https://news.example/story", title: "Rates hold & lenders react", description: "Short summary.", image_url: "https://cdn.news.example/a.jpg", site: "Example News" });
  });
  it("makes a relative picture address absolute and falls back to the page title", () => {
    const p = previewFromHtml(page(`<title>Plain   title</title><meta name="twitter:image" content="/img/b.png">`), "https://news.example/a/b");
    expect(p.image_url).toBe("https://news.example/img/b.png");
    expect(p.title).toBe("Plain title");
  });
  it("drops a picture that is not public https", () => {
    expect(previewFromHtml(page(`<meta property="og:image" content="http://news.example/a.jpg">`), "https://news.example/").image_url).toBeNull();
    expect(previewFromHtml(page(`<meta property="og:image" content="https://169.254.169.254/latest">`), "https://news.example/").image_url).toBeNull();
    expect(previewFromHtml(page(`<meta property="og:image" content="https://localhost/a.jpg">`), "https://news.example/").image_url).toBeNull();
  });
  it("follows a redirect, checking each address", async () => {
    const http = vi.fn<HttpClient>()
      .mockResolvedValueOnce({ status: 301, headers: { location: "https://www.news.example/story" }, text: "" })
      .mockResolvedValueOnce(ok(page(`<meta property="og:image" content="https://www.news.example/p.jpg">`)));
    const p = await fetchLinkPreview("https://news.example/story", http);
    expect(p.image_url).toBe("https://www.news.example/p.jpg");
    expect(http.mock.calls.map((c) => c[0].url)).toEqual(["https://news.example/story", "https://www.news.example/story"]);
  });
  it("refuses private, internal and non-https addresses without fetching", async () => {
    const http = vi.fn<HttpClient>();
    for (const bad of ["http://news.example/", "https://localhost/x", "https://10.0.0.5/x", "https://169.254.169.254/", "ftp://x.example", ""]) {
      await expect(fetchLinkPreview(bad, http)).rejects.toBeInstanceOf(LinkPreviewError);
    }
    expect(http).not.toHaveBeenCalled();
  });
  it("a redirect to an internal address is refused", async () => {
    const http = vi.fn<HttpClient>().mockResolvedValueOnce({ status: 302, headers: { location: "https://169.254.169.254/latest/meta-data" }, text: "" });
    await expect(fetchLinkPreview("https://news.example/story", http)).rejects.toBeInstanceOf(LinkPreviewError);
    expect(http).toHaveBeenCalledTimes(1);
  });
  it("says so plainly when the page cannot be read", async () => {
    await expect(fetchLinkPreview("https://news.example/x", vi.fn<HttpClient>().mockResolvedValue({ status: 404, headers: {}, text: "" }))).rejects.toThrow(/did not open/);
    await expect(fetchLinkPreview("https://news.example/x", vi.fn<HttpClient>().mockRejectedValue(new Error("ETIMEDOUT")))).rejects.toThrow(/could not be reached/);
    await expect(fetchLinkPreview("https://news.example/x.pdf", vi.fn<HttpClient>().mockResolvedValue({ status: 200, headers: { "content-type": "application/pdf" }, text: "%PDF" }))).rejects.toThrow(/not a web page/);
  });
});
