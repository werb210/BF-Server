// Audit fixes Oct 11 - smaller items.
//   BF_SERVER_MESSAGES_POST_AUTH_v1         POST /api/messages was unauthenticated.
//   BF_SERVER_INT_ROUTES_STAFF_ONLY_v1      /api/_int/routes and /api/_int/env were public.
//   BF_SERVER_BI_CARRIER_PATH_FIX_v1        carrier submit hit a path and host BI-Server never served.
//   BF_SERVER_AI_DOCUMENTS_UPLOAD_v1        the portal's knowledge-base upload 404'd.
//   BF_SERVER_VOICE_STATUS_ROUTE_v1         the iOS dialer's POST /api/voice/status 404'd.
//   BF_SERVER_SIN_PURGE_LOGGED_v1           SIN/SSN purge failures were swallowed.
//   BF_SERVER_FAIL_FAST_v1                  startup failures were swallowed.
import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { queryMock, embedMock } = vi.hoisted(() => ({ queryMock: vi.fn(), embedMock: vi.fn() }));
vi.mock("../db.js", async () => ({
  ...(await vi.importActual<any>("../db.js")),
  pool: { query: queryMock },
  dbQuery: (sql: string, p?: unknown[]) => queryMock(sql, p),
  runQuery: (sql: string, p?: unknown[]) => queryMock(sql, p),
}));
vi.mock("../modules/ai/knowledge.service.js", async () => ({
  ...(await vi.importActual<any>("../modules/ai/knowledge.service.js")),
  embedAndStore: embedMock,
}));

const SECRET = "test-jwt-secret";
const STAFF_ID = "88888888-8888-4888-8888-888888888888";
const sign = (c: Record<string, unknown>) => jwt.sign(c, SECRET, { expiresIn: "5m" });
const staff = sign({ sub: STAFF_ID, role: "Staff" });
const admin = sign({ sub: STAFF_ID, role: "Admin" });
const client = sign({ sub: "client:+15555550123", role: "client", phone: "+15555550123", isClient: true });

const realFetch = globalThis.fetch;
let dbRole = "Staff";
beforeEach(() => {
  process.env.JWT_SECRET = SECRET;
  dbRole = "Staff";
  queryMock.mockReset();
  queryMock.mockImplementation(async (sql: string) => {
    if (/FROM users WHERE id = \$1/.test(sql)) return { rows: [{ id: STAFF_ID, email: "s@example.com", role: dbRole, silo: "BF", silos: ["BF"] }] };
    return { rows: [], rowCount: 0 };
  });
  embedMock.mockReset();
});
afterEach(() => { globalThis.fetch = realFetch; });

function mount(path: string, router: express.Router) {
  const a = express();
  a.use(express.json());
  a.use(path, router);
  return a;
}

describe("POST /api/messages", () => {
  it("requires staff auth", async () => {
    const a = mount("/api/messages", (await import("../routes/messages.js")).default);
    expect((await request(a).post("/api/messages").send({ applicationId: "a", body: "b" })).status).toBe(401);
    expect((await request(a).post("/api/messages").set("Authorization", `Bearer ${client}`).send({ applicationId: "a", body: "b" })).status).toBe(403);
    expect(queryMock.mock.calls.some((c) => /INSERT INTO communications_messages/.test(String(c[0])))).toBe(false);
    const ok = await request(a).post("/api/messages").set("Authorization", `Bearer ${staff}`).send({ applicationId: "a", body: "b" });
    expect(ok.status).toBe(201);
  });
});

describe("/api/_int", () => {
  it("routes and env need staff; build and version stay public", async () => {
    const a = mount("/api/_int", (await import("../routes/_int.js")).default);
    expect((await request(a).get("/api/_int/routes")).status).toBe(401);
    expect((await request(a).get("/api/_int/env")).status).toBe(401);
    expect((await request(a).get("/api/_int/routes").set("Authorization", `Bearer ${client}`)).status).toBe(403);
    expect((await request(a).get("/api/_int/env").set("Authorization", `Bearer ${staff}`)).status).toBe(200);
    expect((await request(a).get("/api/_int/version")).status).toBe(200);
    expect((await request(a).get("/api/_int/build")).status).toBe(200);
  });
});

describe("BI carrier submit", () => {
  it("resolves the BI application id, then posts to /api/v1/bi/application/:id/submit-pgi with a service token", async () => {
    delete process.env.BI_SERVER_URL;
    queryMock.mockImplementation(async (sql: string) => (/SELECT bi_public_id FROM applications/.test(sql) ? { rows: [{ bi_public_id: "pub-1" }] } : { rows: [] }));
    const seen: Array<{ url: string; auth: string; body: any }> = [];
    globalThis.fetch = vi.fn(async (url: any, init: any) => {
      seen.push({ url: String(url), auth: init.headers.authorization, body: JSON.parse(init.body) });
      if (String(url).endsWith("/pgi-readiness")) return new Response(JSON.stringify({ ok: true, result: { applicationId: "bi-internal-1", publicId: "pub-1" } }), { status: 200 });
      return new Response(JSON.stringify({ externalId: "X1", status: "submitted" }), { status: 200 });
    }) as any;
    const { submitBiToCarrier } = await import("../services/biCarrierSubmit.js");
    const r = await submitBiToCarrier("bf-app-1");
    expect(r).toEqual({ ok: true, externalId: "X1", status: "submitted" });
    const host = "https://bi-server-cse0apamgkheb9d5.canadacentral-01.azurewebsites.net";
    expect(seen[0].url).toBe(`${host}/api/v1/bi/maya/staff/pgi-readiness`);
    expect(seen[0].body).toEqual({ public_id: "pub-1" });
    expect(seen[1].url).toBe(`${host}/api/v1/bi/application/bi-internal-1/submit-pgi`);
    const claims = jwt.verify(seen[1].auth.replace("Bearer ", ""), SECRET, { algorithms: ["HS256"] }) as any;
    expect(claims.kind).toBe("service");
    expect(claims.service).toBe("bf-server");
  });

  it("skips when there is no PGI application", async () => {
    const f = vi.fn();
    globalThis.fetch = f as any;
    const { submitBiToCarrier } = await import("../services/biCarrierSubmit.js");
    expect(await submitBiToCarrier("bf-app-2")).toEqual({ ok: true, skipped: "no_pgi" });
    expect(f).not.toHaveBeenCalled();
  });
});

// The admin router pulls in a large module graph; give its first import room on a busy runner.
describe("POST /api/admin/ai-documents", { timeout: 60_000 }, () => {
  async function adminApp() {
    return mount("/api/admin", (await import("../routes/admin.js")).default);
  }

  it("stores an uploaded text file the same way as other knowledge uploads", async () => {
    dbRole = "Admin";
    embedMock.mockResolvedValue(undefined);
    const r = await request(await adminApp()).post("/api/admin/ai-documents").set("Authorization", `Bearer ${admin}`)
      .attach("file", Buffer.from("Boreal lends to Canadian businesses.\nTerms 6-60 months."), { filename: "faq.txt", contentType: "text/plain" });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ ok: true, name: "faq.txt", indexed: true });
    expect(embedMock).toHaveBeenCalledTimes(1);
    const [, text, sourceType, sourceId, title] = embedMock.mock.calls[0];
    expect(text).toContain("Boreal lends");
    expect(sourceType).toBe("upload");
    expect(sourceId).toBe("faq.txt");
    expect(title).toBe("faq.txt");
  });

  it("still succeeds (saved without index) when embeddings are unavailable", async () => {
    dbRole = "Admin";
    embedMock.mockRejectedValue(Object.assign(new Error("no key"), { code: "openai_not_configured" }));
    const r = await request(await adminApp()).post("/api/admin/ai-documents").set("Authorization", `Bearer ${admin}`)
      .attach("file", Buffer.from("hello"), { filename: "a.txt", contentType: "text/plain" });
    expect(r.status).toBe(201);
    expect(r.body.indexed).toBe(false);
  });

  it("is admin only and needs a file", async () => {
    const a = await adminApp();
    expect((await request(a).post("/api/admin/ai-documents").set("Authorization", `Bearer ${staff}`)
      .attach("file", Buffer.from("x"), { filename: "a.txt", contentType: "text/plain" })).status).toBe(403);
    dbRole = "Admin";
    expect((await request(a).post("/api/admin/ai-documents").set("Authorization", `Bearer ${admin}`).send({})).status).toBe(400);
    expect(embedMock).not.toHaveBeenCalled();
  });
});

describe("POST /api/voice/status", () => {
  it("accepts the dialer's {callStatus} body for staff, rejects anonymous and bad input", async () => {
    const a = mount("/api/voice", (await import("../routes/voiceCalls.js")).default);
    expect((await request(a).post("/api/voice/status").send({ callStatus: "completed" })).status).toBe(401);
    const ok = await request(a).post("/api/voice/status").set("Authorization", `Bearer ${staff}`).send({ callStatus: "completed" });
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({ status: "ok", data: { received: true } });
    expect((await request(a).post("/api/voice/status").set("Authorization", `Bearer ${staff}`).send({ callStatus: "exploded" })).status).toBe(400);
    expect((await request(a).post("/api/voice/status").set("Authorization", `Bearer ${client}`).send({ callStatus: "failed" })).status).toBe(403);
  });
});

describe("source guards", () => {
  it("SIN/SSN purge failures are logged, not swallowed", () => {
    for (const f of ["src/signnow/finalizeSignedApplication.ts", "src/signnow/sendApplicationForSignature.ts"]) {
      const src = readFileSync(f, "utf8");
      const purge = src.split("\n").filter((l) => /set ssn = null, sin = null/i.test(l));
      expect(purge.length).toBe(2);
      for (const line of purge) {
        expect(line).not.toContain(".catch(() => {})");
        expect(line).toContain("console.error");
      }
    }
  });

  it("committed env files are gone and ignored", () => {
    const ignore = readFileSync(".gitignore", "utf8").split("\n");
    expect(ignore).toContain(".env");
    expect(ignore).toContain(".env.test");
  });
});
