// BF_SERVER_BLOCK_v497_OUTBOUND_MMS
import express from "express";
import jwt from "jsonwebtoken";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { answerBySql, callsMatching } from "./helpers/answerBySql.js";

const { queryMock, createMock, uploadMock } = vi.hoisted(() => ({ queryMock: vi.fn(), createMock: vi.fn(), uploadMock: vi.fn() }));
vi.mock("../db.js", async () => {
  const actual = await vi.importActual<typeof import("../db.js")>("../db.js");
  return { ...actual, pool: { query: queryMock }, runQuery: queryMock };
});
vi.mock("../lib/sharedClients.js", () => ({
  sharedTwilio: () => ({ messages: { create: createMock } }),
  sharedOpenAI: () => ({}),
}));
vi.mock("../services/mmsMedia.js", () => ({
  uploadInboundMmsBlob: uploadMock,
  fetchTwilioMedia: vi.fn(async () => null),
  persistTwilioMediaToBlob: vi.fn(async () => null),
}));

const STAFF_ID = "00000000-0000-4000-8000-0000000000a1";
const TO = "+15874441234";
const BLOB = "https://blob.example/mms/abc.png";
const token = () => jwt.sign({ sub: STAFF_ID, id: STAFF_ID, role: "Admin", tokenVersion: 0, tv: 0 }, String(process.env.JWT_SECRET));
const dataUrl = (ct: string, bytes: number) => `data:${ct};base64,${Buffer.alloc(bytes, 1).toString("base64")}`;

async function send(body: Record<string, unknown>) {
  const router = (await import("../routes/communications.js")).default;
  const a = express();
  a.use(express.json({ limit: "20mb" }));
  a.use("/api/communications", router);
  return request(a).post("/api/communications/sms").set("Authorization", `Bearer ${token()}`).send(body);
}

beforeEach(() => {
  queryMock.mockReset();
  createMock.mockReset();
  uploadMock.mockReset();
  createMock.mockResolvedValue({ sid: "SM1", status: "queued" });
  uploadMock.mockResolvedValue(BLOB);
  process.env.TWILIO_FROM_NUMBER = "+15875550100";
  queryMock.mockImplementation(answerBySql([]));
});
afterEach(() => { delete process.env.TWILIO_FROM_NUMBER; });

describe("v497 outbound MMS", () => {
  it("accepts one picture or PDF and refuses other types", async () => {
    for (const ct of ["image/jpeg", "image/png", "image/gif", "application/pdf"]) {
      const res = await send({ to: TO, body: "see attached", media: { contentType: ct, dataUrl: dataUrl(ct, 10) } });
      expect(res.status, ct).toBe(200);
    }
    const bad = await send({ to: TO, body: "x", media: { contentType: "video/mp4", dataUrl: dataUrl("video/mp4", 10) } });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe("mms_type_not_allowed");
  });

  it("refuses a file over 5 MB", async () => {
    const ok = await send({ to: TO, body: "x", media: { contentType: "image/png", dataUrl: dataUrl("image/png", 5 * 1024 * 1024) } });
    expect(ok.status).toBe(200);
    const big = await send({ to: TO, body: "x", media: { contentType: "image/png", dataUrl: dataUrl("image/png", 5 * 1024 * 1024 + 1) } });
    expect(big.status).toBe(400);
    expect(big.body.error.code).toBe("mms_too_large");
  });

  it("only texts pictures to US or Canadian numbers", async () => {
    const res = await send({ to: "+447700900123", body: "x", media: { contentType: "image/png", dataUrl: dataUrl("image/png", 10) } });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("mms_country_not_supported");
    expect(uploadMock).not.toHaveBeenCalled();
    expect(createMock).not.toHaveBeenCalled();
  });

  it("sends the media to Twilio and records it on the message", async () => {
    const res = await send({ to: TO, body: "here it is", media: { contentType: "image/png", dataUrl: dataUrl("image/png", 10) } });
    expect(res.status).toBe(200);
    expect(uploadMock).toHaveBeenCalledWith(expect.any(Buffer), "image/png");
    expect(createMock.mock.calls[0]![0].mediaUrl).toEqual([BLOB]);
    const [insert] = callsMatching(queryMock, "INSERT INTO communications_messages");
    expect(insert![0]).toMatch(/media_url/);
    expect((insert![1] as unknown[]).at(-1)).toBe(BLOB);
  });

  it("a plain text carries no media", async () => {
    const res = await send({ to: TO, body: "hello" });
    expect(res.status).toBe(200);
    expect(createMock.mock.calls[0]![0]).not.toHaveProperty("mediaUrl");
    const [insert] = callsMatching(queryMock, "INSERT INTO communications_messages");
    expect((insert![1] as unknown[]).at(-1)).toBeNull();
  });

  it("a text with only a picture is allowed; nothing at all is not", async () => {
    const pic = await send({ to: TO, media: { contentType: "image/jpeg", dataUrl: dataUrl("image/jpeg", 10) } });
    expect(pic.status).toBe(200);
    expect(createMock.mock.calls[0]![0].mediaUrl).toEqual([BLOB]);
    const empty = await send({ to: TO });
    expect(empty.status).toBe(400);
    expect(empty.body.error.code).toBe("validation_error");
  });
});
