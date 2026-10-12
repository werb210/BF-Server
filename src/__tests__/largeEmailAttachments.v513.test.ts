// BF_SERVER_BLOCK_v513_LARGE_EMAIL_ATTACHMENTS
import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";
import { answerBySql } from "./helpers/answerBySql.js";

const h = vi.hoisted(() => ({ query: vi.fn(), graphFetch: vi.fn() }));
vi.mock("../db.js", async (orig) => {
  const real: any = await orig();
  const q = (sql: unknown, params?: unknown[]) => h.query(sql, params);
  const pool = { query: q, connect: async () => ({ query: q, release: () => undefined }) };
  return { ...real, pool, db: pool, default: pool, dbQuery: q, runQuery: q, query: q };
});
vi.mock("../modules/o365/graphClient.js", async (orig) => {
  const real: any = await orig();
  return { ...real, getGraphForUser: async () => ({ accessToken: "t", fetch: (path: string, init?: RequestInit) => h.graphFetch(path, init) }) };
});

import o365, { base64Size, needsUploadPath, INLINE_ATTACHMENT_LIMIT } from "../routes/o365.js";
import { createApp } from "../app.js";

const b64Of = (bytes: number) => Buffer.alloc(bytes, 7).toString("base64");
const staff = () =>
  "Bearer " + jwt.sign({ sub: "11111111-1111-4111-8111-111111111111", role: "Admin", tokenVersion: 0, tv: 0 }, process.env.JWT_SECRET as string);

const router = express();
router.use(express.json({ limit: "50mb" }));
router.use("/api/o365", o365);

const graphPaths = () => h.graphFetch.mock.calls.map((c) => `${(c[1] as RequestInit | undefined)?.method ?? "GET"} ${c[0]}`);

beforeEach(() => {
  h.query.mockReset();
  h.query.mockImplementation(answerBySql([]));
  h.graphFetch.mockReset();
  h.graphFetch.mockImplementation(async (path: string, init?: RequestInit) => {
    if (path === "/me/messages" && init?.method === "POST") return new Response(JSON.stringify({ id: "D1" }), { status: 201 });
    if (path.endsWith("/attachments/createUploadSession")) return new Response(JSON.stringify({ uploadUrl: "https://outlook.office.com/upload/xyz" }), { status: 200 });
    if (path.endsWith("/send")) return new Response(null, { status: 202 });
    if (path === "/me/sendMail") return new Response(null, { status: 202 });
    return new Response("{}", { status: 200 });
  });
  vi.spyOn(console, "log").mockImplementation(() => undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

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

  it("refuses attachments over 25 MB in total", async () => {
    const r = await request(router).post("/api/o365/mail/send").set("Authorization", staff()).send({
      to: ["a@x.com"], subject: "s", body_html: "<p>x</p>",
      attachments: [{ name: "a.pdf", contentType: "application/pdf", contentBytes: b64Of(13 * 1024 * 1024) }, { name: "b.pdf", contentType: "application/pdf", contentBytes: b64Of(13 * 1024 * 1024) }],
    });
    expect(r.status).toBe(413);
    expect(r.body.error).toBe("attachments_too_large");
    expect(graphPaths().some((p) => p.includes("sendMail") || p.includes("/messages"))).toBe(false);
  });

  it("a small attachment goes inline through sendMail", async () => {
    const r = await request(router).post("/api/o365/mail/send").set("Authorization", staff()).send({
      to: ["a@x.com"], subject: "s", body_html: "<p>x</p>",
      attachments: [{ name: "a.pdf", contentType: "application/pdf", contentBytes: b64Of(1000) }],
    });
    expect(r.status).toBe(200);
    const send = h.graphFetch.mock.calls.find((c) => c[0] === "/me/sendMail")!;
    expect(JSON.parse(String((send[1] as RequestInit).body)).message.attachments).toHaveLength(1);
    expect(graphPaths().some((p) => p.includes("createUploadSession"))).toBe(false);
  });

  it("a large attachment is drafted, uploaded in pieces without the Graph token, then the draft is sent", async () => {
    const put = vi.fn(async (_url: string, _init: RequestInit) => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", put);
    const bytes = 4 * 1024 * 1024;
    const r = await request(router).post("/api/o365/mail/send").set("Authorization", staff()).send({
      to: ["a@x.com"], subject: "s", body_html: "<p>x</p>",
      attachments: [{ name: "big.pdf", contentType: "application/pdf", contentBytes: b64Of(bytes) }],
    });
    expect(r.status).toBe(200);
    const paths = graphPaths();
    expect(paths).toContain("POST /me/messages");
    expect(paths).toContain("POST /me/messages/D1/attachments/createUploadSession");
    expect(paths).toContain("POST /me/messages/D1/send");
    expect(paths).not.toContain("POST /me/sendMail");
    expect(paths.indexOf("POST /me/messages/D1/attachments/createUploadSession")).toBeLessThan(paths.indexOf("POST /me/messages/D1/send"));
    // The draft itself carries no inline copy of the file.
    const draft = h.graphFetch.mock.calls.find((c) => c[0] === "/me/messages")!;
    expect(JSON.parse(String((draft[1] as RequestInit).body)).attachments).toBeUndefined();
    // Pieces go straight to the pre-authorised upload URL and cover every byte.
    expect(put.mock.calls.length).toBeGreaterThan(1);
    for (const [url, init] of put.mock.calls) {
      expect(url).toBe("https://outlook.office.com/upload/xyz");
      expect((init.headers as Record<string, string>).Authorization).toBeUndefined();
    }
    const last = put.mock.calls[put.mock.calls.length - 1]![1].headers as Record<string, string>;
    expect(last["Content-Range"]).toMatch(new RegExp(`^bytes \\d+-${bytes - 1}/${bytes}$`));
  });

  it("a failed piece deletes the draft instead of sending it", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 500 })));
    const r = await request(router).post("/api/o365/mail/send").set("Authorization", staff()).send({
      to: ["a@x.com"], subject: "s", body_html: "<p>x</p>",
      attachments: [{ name: "big.pdf", contentType: "application/pdf", contentBytes: b64Of(4 * 1024 * 1024) }],
    });
    expect(r.status).toBe(502);
    expect(r.body.error).toBe("attachment_upload_failed");
    expect(graphPaths()).toContain("DELETE /me/messages/D1");
    expect(graphPaths()).not.toContain("POST /me/messages/D1/send");
  });

  it("the app lets the send route take a body over the 10 MB global limit", async () => {
    const app = createApp();
    // 12 MB of JSON: within the send route's own 50 MB parser, over the global 10 MB one.
    const big = { to: [], subject: "s", body_html: "x".repeat(12 * 1024 * 1024) };
    const send = await request(app).post("/api/o365/mail/send").set("Authorization", staff()).send(big);
    expect(send.status).toBe(400);
    expect(send.body.error).toBe("to required");
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const draft = await request(app).post("/api/o365/mail/draft").set("Authorization", staff()).send(big);
    expect(draft.status).toBeGreaterThanOrEqual(400);
    expect(draft.status).not.toBe(400);
  });
});
