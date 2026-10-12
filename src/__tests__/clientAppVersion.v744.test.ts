// BF_SERVER_CLIENT_APP_VERSION_v744
import { afterEach, describe, it, expect, vi } from "vitest";
import express from "express";
import request from "supertest";

const APP = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const h = vi.hoisted(() => ({ sql: [] as string[] }));
vi.mock("../db.js", async (orig) => {
  const real: any = await orig();
  // An existing, claimed application: the ownership guard would refuse a caller with no token.
  const q = async (sql: string, params: unknown[] = []) => {
    h.sql.push(String(sql));
    if (/FROM applications WHERE lower\(id::text\) = ANY/.test(sql)) return { rows: (params[0] as string[]).includes(APP) ? [{ id: APP }] : [] };
    if (sql.includes("WITH app_phones AS")) return { rows: [{ total: 1, mine: 0, known: 1 }] };
    return { rows: [] };
  };
  const pool = { query: q, connect: async () => ({ query: q, release: () => undefined }) };
  return { ...real, dbQuery: q, runQuery: q, query: q, pool, db: pool, default: pool };
});

import clientRouter from "../routes/client/index.js";

const app = express();
app.use(express.json());
app.use("/api/client", clientRouter);

afterEach(() => { delete process.env.CLIENT_APP_MIN_BUILD; h.sql.length = 0; });

describe("client app version check", () => {
  it("serves the minimum app build, defaulting when CLIENT_APP_MIN_BUILD is unset", async () => {
    const r = await request(app).get("/api/client/app-version");
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ minBuild: "2026-10-04T00:00:00Z", webUrl: "https://client.boreal.financial" });
    process.env.CLIENT_APP_MIN_BUILD = "2026-11-01T00:00:00Z";
    expect((await request(app).get("/api/client/app-version")).body.minBuild).toBe("2026-11-01T00:00:00Z");
  });

  it("answers before the client sign-in checks", async () => {
    // An old app with no session, naming an application it does not own, still learns it must update.
    const r = await request(app).get(`/api/client/app-version?applicationId=${APP}`);
    expect(r.status).toBe(200);
    expect(r.body.minBuild).toBeTruthy();
    expect(h.sql).toEqual([]);
    // The same request to a guarded read is refused.
    expect((await request(app).get(`/api/client/messages?applicationId=${APP}`)).status).toBe(401);
  });

  it("is not counted against the client read limit", async () => {
    for (let i = 0; i < 130; i += 1) {
      const r = await request(app).get("/api/client/app-version");
      expect(r.status).toBe(200);
    }
  });
});
