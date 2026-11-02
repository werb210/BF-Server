// BF_SERVER_v875_API_KEYS - API keys and the public REST API with a fake database that answers by SQL content: only a
// hash of the key is stored; a missing, malformed, unknown or revoked key gets 401; each endpoint needs its own
// permission (403 insufficient_scope); a key only reaches its own silo's records; each key has its own per-minute
// limit; writes are audit-logged with the key's id.
import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  keys: [] as Array<Record<string, any>>,
  contacts: [] as Array<Record<string, any>>,
  audits: [] as Array<Record<string, any>>,
  queries: [] as Array<{ sql: string; params: any[] }>,
}));

vi.mock("../../db.js", () => ({ pool: { query: vi.fn(async () => ({ rows: [] })) } }));
vi.mock("../../modules/audit/audit.service.js", () => ({
  recordAuditEvent: vi.fn(async (e: Record<string, any>) => { state.audits.push(e); }),
}));
vi.mock("../../modules/automation/automationEngine.js", () => ({ emitAutomationEvent: vi.fn(async () => undefined) }));
vi.mock("../../services/contacts.js", () => ({
  createContact: vi.fn(async (_db: unknown, input: Record<string, any>) => {
    const row = { id: "99999999-9999-4999-8999-999999999999", ...input, name: `${input.first_name} ${input.last_name}` };
    state.contacts.push(row);
    return row;
  }),
}));

import { createPublicApiRouter } from "../router.js";
import { generateApiKey, hashApiKey, normalizeScopes, parseApiKey, keyMatches, currentPepper } from "../../apiKeys/keys.js";

const fakeDb = {
  query: async (sql: string, params: any[] = []) => {
    state.queries.push({ sql, params });
    if (/FROM api_keys WHERE id = \$1::uuid/.test(sql)) return { rows: state.keys.filter((k) => k.id === params[0]) };
    if (/UPDATE api_keys SET last_used_at/.test(sql)) return { rows: [], rowCount: 1 };
    if (/FROM contacts c LEFT JOIN companies co/.test(sql)) {
      const silo = params[0];
      const rows = state.contacts.filter((c) => c.silo === silo && (!/c\.id = \$2/.test(sql) || c.id === params[1]));
      return { rows: rows.map((c) => ({ id: c.id, name: c.name, email: c.email ?? null, silo: c.silo })) };
    }
    if (/UPDATE contacts SET/.test(sql)) return { rows: [], rowCount: 1 };
    return { rows: [] };
  },
};

const app = express();
app.use(express.json());
app.use("/api/open/v1", createPublicApiRouter({ db: () => fakeDb }));

const PEPPER = { source: "jwt" as const, pepper: String(process.env.JWT_SECRET) };
function addKey(extra: Record<string, any> = {}) {
  const k = generateApiKey(PEPPER);
  state.keys.push({
    id: k.id, name: "Zapier", silo: "BF", scopes: ["contacts:read"], key_prefix: k.key_prefix, key_hash: k.key_hash,
    pepper_source: k.pepper_source, rate_limit_per_minute: 120, created_by: "11111111-1111-4111-8111-111111111111",
    revoked_at: null, ...extra,
  });
  return k.key;
}

beforeEach(() => {
  state.keys = []; state.audits = []; state.queries = [];
  state.contacts = [
    { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", name: "BF Person", silo: "BF" },
    { id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", name: "BI Person", silo: "BI" },
  ];
});

describe("keys", () => {
  it("are shown once and stored only as a hash; the shape carries the id", () => {
    const k = generateApiKey(PEPPER);
    expect(k.key).toMatch(/^bf_live_[0-9a-f]{32}_[A-Za-z0-9_-]{43}$/);
    expect(k.key_hash).toBe(hashApiKey(k.key, PEPPER.pepper));
    expect(k.key_hash).not.toContain(k.key.slice(-20));
    expect(parseApiKey(k.key)).toEqual({ id: k.id });
    expect(keyMatches({ key_hash: k.key_hash, pepper_source: "jwt" }, k.key)).toBe(true);
    expect(keyMatches({ key_hash: k.key_hash, pepper_source: "jwt" }, k.key.slice(0, -1) + "x")).toBe(false);
    expect(currentPepper({ JWT_SECRET: "x".repeat(16) } as any)).toEqual({ source: "jwt", pepper: "x".repeat(16) });
    expect(currentPepper({ JWT_SECRET: "x".repeat(16), API_KEY_PEPPER: "p".repeat(16) } as any)?.source).toBe("env");
  });

  it("permissions: a write brings its read; unknown ones are refused", () => {
    expect(normalizeScopes(["contacts:write", "lenders:read"])).toEqual({ ok: true, scopes: ["contacts:read", "contacts:write", "lenders:read"] });
    expect(normalizeScopes(["contacts:delete"]).ok).toBe(false);
    expect(normalizeScopes([]).ok).toBe(false);
  });
});

describe("public API", () => {
  it("needs a valid, unrevoked key", async () => {
    expect((await request(app).get("/api/open/v1/contacts")).body.error.code).toBe("unauthorized");
    expect((await request(app).get("/api/open/v1/contacts").set("Authorization", "Bearer nope")).body.error.code).toBe("invalid_api_key");
    const revoked = addKey({ revoked_at: new Date().toISOString() });
    const r = await request(app).get("/api/open/v1/contacts").set("Authorization", `Bearer ${revoked}`);
    expect(r.status).toBe(401);
    expect(r.body.error.code).toBe("api_key_revoked");
    expect((await request(app).get("/api/open/v1/openapi.json")).body.info.title).toBe("Boreal REST API");
  });

  it("reads only the key's silo", async () => {
    const bf = addKey();
    const bi = addKey({ silo: "BI" });
    const a = await request(app).get("/api/open/v1/contacts").set("Authorization", `Bearer ${bf}`);
    expect(a.status).toBe(200);
    expect(a.body.data.map((c: any) => c.name)).toEqual(["BF Person"]);
    const b = await request(app).get("/api/open/v1/contacts").set("Authorization", `Bearer ${bi}`);
    expect(b.body.data.map((c: any) => c.name)).toEqual(["BI Person"]);
    // Another silo's record is "not found".
    const cross = await request(app).get("/api/open/v1/contacts/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb").set("Authorization", `Bearer ${bf}`);
    expect(cross.status).toBe(404);
  });

  it("each endpoint needs its permission", async () => {
    const readOnly = addKey();
    const w = await request(app).post("/api/open/v1/contacts").set("Authorization", `Bearer ${readOnly}`).send({ first_name: "A", last_name: "B" });
    expect(w.status).toBe(403);
    expect(w.body.error.code).toBe("insufficient_scope");
    const apps = await request(app).get("/api/open/v1/applications").set("Authorization", `Bearer ${readOnly}`);
    expect(apps.status).toBe(403);
    expect(state.contacts).toHaveLength(2);
  });

  it("a write key creates in its own silo, owned by the key's creator, and the change is audit-logged", async () => {
    const key = addKey({ silo: "BI", scopes: ["contacts:read", "contacts:write"] });
    const r = await request(app).post("/api/open/v1/contacts").set("Authorization", `Bearer ${key}`).send({ first_name: "Ann", last_name: "Lee", email: "ann@example.com" });
    expect(r.status).toBe(201);
    expect(state.contacts[2]).toMatchObject({ silo: "BI", owner_id: "11111111-1111-4111-8111-111111111111", email: "ann@example.com" });
    expect(state.audits).toEqual([expect.objectContaining({ action: "api_contact_created", metadata: expect.objectContaining({ via: "api_key", silo: "BI", api_key_id: state.keys[0]!.id }) })]);
  });

  it("each key has its own requests-per-minute limit", async () => {
    const slow = addKey({ rate_limit_per_minute: 2 });
    const fast = addKey({ rate_limit_per_minute: 50 });
    const hit = (k: string) => request(app).get("/api/open/v1/me").set("Authorization", `Bearer ${k}`);
    expect((await hit(slow)).status).toBe(200);
    expect((await hit(slow)).status).toBe(200);
    const third = await hit(slow);
    expect(third.status).toBe(429);
    expect(third.body.error.code).toBe("rate_limited");
    expect((await hit(fast)).status).toBe(200);
  });
});
