// BF_SERVER_v789_ID_NORMALIZE + BF_SERVER_v789_FORM_RESPONSE_AUTH
// The client router's ownership guard read the raw path, so a percent-encoded,
// UPPERCASE or double-encoded application id slipped past it while Express (and
// Postgres) still resolved it to the real application. Form-response routes
// treated "no Authorization header" as allowed.
import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";

process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret-min-10-chars";

const OWNED = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const OWNER_PHONE = "+15875550123";
const OTHER_PHONE = "+15875550199";

const sqls: string[] = [];
function answer(sql: string, params: unknown[] = []) {
  sqls.push(sql);
  if (/FROM applications WHERE lower\(id::text\) = ANY\(\$1::text\[\]\)/.test(sql)) {
    const ids = (params[0] as string[]) ?? [];
    return { rows: ids.includes(OWNED) ? [{ id: OWNED }] : [], rowCount: ids.includes(OWNED) ? 1 : 0 };
  }
  if (sql.includes("WITH app_phones AS")) {
    if (params[0] === OWNED) {
      return { rows: [{ total: 1, mine: params[1] === OWNER_PHONE.slice(-10) ? 1 : 0, known: 1 }] };
    }
    return { rows: [{ total: 0, mine: 0, known: 0 }] };
  }
  return { rows: [], rowCount: 0 };
}

vi.mock("../db.js", async (orig) => {
  const real: any = await orig();
  const q = async (sql: string, params?: unknown[]) => answer(String(sql), params ?? []);
  const pool = { query: q, connect: async () => ({ query: q, release: () => undefined }) };
  return { ...real, dbQuery: q, runQuery: q, query: q, pool, db: pool, default: pool };
});

const token = (phone: string) => "Bearer " + jwt.sign({ sub: "client:" + phone, role: "client", phone, isClient: true }, process.env.JWT_SECRET as string, { algorithm: "HS256" });

// The id as a non-owner might spell it.
const ENCODED = "%62" + OWNED.slice(1); // %62 = "b"
const UPPER = OWNED.toUpperCase();
const DOUBLE = "%2562" + OWNED.slice(1); // decodes to %62bbbb..., then to the id

async function clientApp() {
  const { default: clientRouter } = await import("../routes/client/index.js");
  const app = express();
  app.use(express.json());
  app.use("/api/client", clientRouter);
  app.use((err: any, _req: any, res: any, _next: any) => {
    res.status(typeof err?.status === "number" ? err.status : 500).json({ error: err?.code || "internal" });
  });
  return app;
}

async function bareV1App() {
  const { default: v1 } = await import("../routes/client/v1Applications.js");
  const app = express();
  app.use(express.json());
  app.use("/api/client", v1);
  app.use((err: any, _req: any, res: any, _next: any) => {
    res.status(typeof err?.status === "number" ? err.status : 500).json({ error: err?.code || "internal" });
  });
  return app;
}

beforeEach(() => {
  sqls.length = 0;
});

describe("candidateApplicationIds normalizes ids", () => {
  it("decodes, lowercases and unwraps double encoding", async () => {
    const { candidateApplicationIds } = await import("../auth/clientApplicationOwnership.js");
    expect(candidateApplicationIds({ path: `/applications/${ENCODED}` })).toEqual([OWNED]);
    expect(candidateApplicationIds({ path: `/applications/${UPPER}` })).toEqual([OWNED]);
    expect(candidateApplicationIds({ path: `/applications/${DOUBLE}/submit` })).toEqual([OWNED]);
    expect(candidateApplicationIds({ path: "/continuation/opaque-token", query: { applicationId: UPPER } })).toEqual([OWNED]);
  });

  it("throws on a segment that cannot be decoded", async () => {
    const { candidateApplicationIds, MalformedApplicationIdError } = await import("../auth/clientApplicationOwnership.js");
    expect(() => candidateApplicationIds({ path: "/applications/%E0%A4%A" })).toThrow(MalformedApplicationIdError);
  });
});

describe("client router rejects disguised ids from a non-owner", () => {
  const variants = [
    ["percent-encoded", ENCODED],
    ["uppercase", UPPER],
    ["double-encoded", DOUBLE],
  ] as const;

  for (const [label, id] of variants) {
    it(`PATCH /applications/:id (${label}) -> 403`, async () => {
      const app = await clientApp();
      const r = await request(app).patch(`/api/client/applications/${id}`).set("Authorization", token(OTHER_PHONE)).send({});
      expect(r.status).toBe(403);
    });

    it(`GET /application/:id/status (${label}) -> 403`, async () => {
      const app = await clientApp();
      const r = await request(app).get(`/api/client/application/${id}/status`).set("Authorization", token(OTHER_PHONE));
      expect(r.status).toBe(403);
    });

    it(`POST /applications/:token/submit (${label}) -> 403`, async () => {
      const app = await clientApp();
      const r = await request(app).post(`/api/client/applications/${id}/submit`).set("Authorization", token(OTHER_PHONE)).send({});
      expect(r.status).toBe(403);
    });

    it(`no token at all (${label}) -> 401`, async () => {
      const app = await clientApp();
      const r = await request(app).get(`/api/client/application/${id}/status`);
      expect(r.status).toBe(401);
    });
  }

  it("the owner still passes the guard with an uppercase id", async () => {
    const app = await clientApp();
    const r = await request(app).get(`/api/client/application/${UPPER}/status`).set("Authorization", token(OWNER_PHONE));
    expect([401, 403]).not.toContain(r.status);
  });

  it("a path segment that cannot be decoded -> 400", async () => {
    const app = await clientApp();
    const r = await request(app).patch("/api/client/applications/%E0%A4%A").set("Authorization", token(OTHER_PHONE)).send({});
    expect(r.status).toBe(400);
  });
});

describe("router.param defense in depth on the applications router alone", () => {
  for (const [label, id] of [["uppercase", UPPER], ["percent-encoded", ENCODED]] as const) {
    it(`PATCH /applications/:id (${label}) from a non-owner -> 403 without the outer guard`, async () => {
      const app = await bareV1App();
      const r = await request(app).patch(`/api/client/applications/${id}`).set("Authorization", token(OTHER_PHONE)).send({});
      expect(r.status).toBe(403);
    });
    it(`POST /applications/:token/submit (${label}) without a token -> 401 without the outer guard`, async () => {
      const app = await bareV1App();
      const r = await request(app).post(`/api/client/applications/${id}/submit`).send({});
      expect(r.status).toBe(401);
    });
  }

  it("a continuation token (not an application id) is left to the handler", async () => {
    const app = await bareV1App();
    const r = await request(app).post("/api/client/applications/some-continuation-token/submit").send({});
    expect(r.status).toBe(404);
  });
});

describe("form-response routes require a token", () => {
  const unknownId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
  it.each([
    ["get", `/api/client/applications/${unknownId}/form-responses`],
    ["get", `/api/client/applications/${unknownId}/form-responses/flinks_banking`],
    ["put", `/api/client/applications/${unknownId}/form-responses/flinks_banking`],
    ["post", `/api/client/applications/${unknownId}/form-responses/flinks_banking/submit`],
    ["get", "/api/client/applications/not-a-uuid/form-responses"],
  ] as const)("%s %s without Authorization -> 401", async (method, path) => {
    const app = await clientApp();
    const r = await (request(app) as any)[method](path).send({ data: { a: 1 } });
    expect(r.status).toBe(401);
    expect(sqls.some((s) => s.includes("application_form_responses"))).toBe(false);
  });

  it("a non-owner with a token is refused on an owned application", async () => {
    const app = await clientApp();
    const r = await request(app).get(`/api/client/applications/${OWNED}/form-responses`).set("Authorization", token(OTHER_PHONE));
    expect(r.status).toBe(403);
  });

  it("the owner can read their form responses", async () => {
    const app = await clientApp();
    const r = await request(app).get(`/api/client/applications/${OWNED}/form-responses`).set("Authorization", token(OWNER_PHONE));
    expect(r.status).toBe(200);
  });
});
