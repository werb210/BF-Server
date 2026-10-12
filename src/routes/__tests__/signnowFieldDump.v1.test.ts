// BF_SERVER_SIGNNOW_FIELD_DUMP_v1
import { afterEach, describe, it, expect, vi } from "vitest";
import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";

const h = vi.hoisted(() => ({ query: vi.fn(async () => ({ rows: [], rowCount: 0 })), getRawCalls: 0, stubUpload: false }));
vi.mock("../../db.js", async (orig) => ({ ...(await orig() as any), pool: { query: h.query, connect: vi.fn() }, runQuery: h.query, dbQuery: h.query }));
vi.mock("../../signnow/signnowClient.js", async (orig) => {
  const real: any = await orig();
  return {
    ...real,
    signnowGetRaw: (...a: [string]) => { h.getRawCalls += 1; return real.signnowGetRaw(...a); },
    uploadDocumentWithFieldExtract: async (...a: unknown[]) => (h.stubUpload ? { documentId: "d-selftest" } : real.uploadDocumentWithFieldExtract(...a)),
  };
});
import * as signnowClient from "../../signnow/signnowClient.js";
import adminRouter from "../admin.js";

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe("signnow field dump diagnostic", () => {
  it("client exposes a raw GET helper", async () => {
    vi.stubEnv("SIGNNOW_API_KEY", "sn-key");
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ fields: [{ type: "text" }] }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    expect(await signnowClient.signnowGetRaw("/document/doc-1")).toEqual({ fields: [{ type: "text" }] });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toMatch(/\/document\/doc-1$/);
    expect(init.method).toBe("GET");
    expect(new Headers(init.headers).get("Authorization")).toBe("Bearer sn-key");
  });

  // BF_SERVER_REPAIR_STALE_TESTS_v1 - the admin fieldDump probe existed to inspect a
  // template's field structure while debugging prefill. Prefill is gone, and so is the
  // probe. signnowGetRaw is retained (asserted above) because it is a general-purpose
  // escape hatch, so keep guarding that and stop asserting for the deleted probe.
  it("the removed prefill-debug probe is not silently reintroduced", async () => {
    h.getRawCalls = 0;
    h.stubUpload = true;
    const app = express();
    app.use(express.json());
    app.use("/api/admin", adminRouter);
    const admin = "Bearer " + jwt.sign({ sub: "73737373-7373-4373-8373-737373737373", role: "Admin", tokenVersion: 0, tv: 0 }, process.env.JWT_SECRET as string);
    const r = await request(app).post("/api/admin/signnow-fieldextract-selftest").set("Authorization", admin);
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(JSON.stringify(r.body)).not.toContain("fieldDump");
    expect(h.getRawCalls).toBe(0);
  });
});
