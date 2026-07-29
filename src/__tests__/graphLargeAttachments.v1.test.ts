import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const jsonResponse = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { "Content-Type": "application/json" },
});

describe("BF_SERVER_GRAPH_LARGE_ATTACHMENTS_v1", () => {
  beforeEach(() => {
    vi.resetModules();
    process.env.MS_GRAPH_TENANT_ID = "tenant";
    process.env.MS_GRAPH_CLIENT_ID = "client";
    process.env.MS_GRAPH_CLIENT_SECRET = "secret";
    process.env.MS_GRAPH_SEND_AS = "sender@example.com";
  });

  afterEach(() => vi.unstubAllGlobals());

  it("keeps small messages on the single sendMail request", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ access_token: "token", expires_in: 3600 }))
      .mockResolvedValueOnce(new Response(null, { status: 202 }));
    vi.stubGlobal("fetch", fetchMock);
    const { sendViaGraph } = await import("../services/email/graphSendService");

    await expect(sendViaGraph({
      to: "lender@example.com", subject: "Package", bodyText: "Attached",
      attachments: [{ filename: "small.pdf", contentType: "application/pdf", content: Buffer.alloc(10) }],
    })).resolves.toEqual({ ok: true, messageId: null });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1][0]).toContain("/sendMail");
  });

  it("creates a draft, attaches files, and sends oversized messages", async () => {
    const large = Buffer.alloc(6 * 1024 * 1024 + 7, 1);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ access_token: "token", expires_in: 3600 }))
      .mockResolvedValueOnce(jsonResponse({ id: "draft/id" }, 201))
      .mockResolvedValueOnce(jsonResponse({ id: "small-attachment" }, 201))
      .mockResolvedValueOnce(jsonResponse({ uploadUrl: "https://upload.example/session" }, 200))
      .mockResolvedValueOnce(jsonResponse({ nextExpectedRanges: ["5242880-"] }, 202))
      .mockResolvedValueOnce(jsonResponse({ id: "large-attachment" }, 201))
      .mockResolvedValueOnce(new Response(null, { status: 202 }));
    vi.stubGlobal("fetch", fetchMock);
    const { sendViaGraph } = await import("../services/email/graphSendService");

    await expect(sendViaGraph({
      to: ["lender@example.com"], subject: "Package", bodyText: "Attached",
      attachments: [
        { filename: "cover.txt", contentType: "text/plain", content: Buffer.from("cover") },
        { filename: "financials.pdf", contentType: "application/pdf", content: large },
      ],
    })).resolves.toEqual({ ok: true, messageId: "draft/id" });

    expect(fetchMock.mock.calls[1][0]).toMatch(/\/messages$/);
    expect(fetchMock.mock.calls[2][0]).toContain("draft%2Fid/attachments");
    expect(fetchMock.mock.calls[3][0]).toContain("createUploadSession");
    const firstPut = fetchMock.mock.calls[4];
    const secondPut = fetchMock.mock.calls[5];
    expect(firstPut[0]).toBe("https://upload.example/session");
    expect(firstPut[1].headers).toEqual({
      "Content-Length": String(5 * 1024 * 1024),
      "Content-Range": `bytes 0-${5 * 1024 * 1024 - 1}/${large.length}`,
    });
    expect(secondPut[1].headers).not.toHaveProperty("Authorization");
    expect(secondPut[1].headers["Content-Range"]).toBe(`bytes ${5 * 1024 * 1024}-${large.length - 1}/${large.length}`);
    expect(fetchMock.mock.calls[6][0]).toContain("draft%2Fid/send");
  });
});
