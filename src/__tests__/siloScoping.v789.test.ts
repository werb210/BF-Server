// BF_SERVER_v789_SILO_SCOPING - CRM leads, contact messages / applications / stage events and
// the per-application routes only answer inside the caller's silo; the dup/phone debug views
// are Admin-only and silo-filtered.
import express from "express";
import jwt from "jsonwebtoken";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { answerBySql, callsMatching } from "./helpers/answerBySql.js";

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));

vi.mock("../db", async () => {
  const actual = await vi.importActual<typeof import("../db.js")>("../db");
  return { ...actual, pool: { query: queryMock }, runQuery: queryMock };
});

const SECRET = "test-secret-v789-silo";
const STAFF_ID = "00000000-0000-0000-0000-0000000000b1";
const ADMIN_ID = "00000000-0000-0000-0000-0000000000a1";
const APP_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const CONTACT_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

const CAPS = ["crm:read", "crm:write", "application:read", "application:write"];
const staffToken = () => jwt.sign({ id: STAFF_ID, role: "Staff", capabilities: CAPS }, SECRET, { algorithm: "HS256" });
const adminToken = () => jwt.sign({ id: ADMIN_ID, role: "Admin", capabilities: CAPS }, SECRET, { algorithm: "HS256" });

// The staff user lives only in BI; the admin defaults to BF.
function usersRule(): [RegExp, (sql: string, params?: unknown[]) => unknown] {
  return [/FROM users WHERE id = \$1/, (_sql, params) => {
    const id = String(params?.[0]);
    if (id === STAFF_ID) return { rows: [{ id: STAFF_ID, email: null, role: "Staff", silo: "BI", silos: ["BI"] }] };
    return { rows: [{ id: ADMIN_ID, email: null, role: "Admin", silo: "BF", silos: ["BF"] }] };
  }];
}

async function buildApp() {
  const crm = (await import("../routes/crm.js")).default;
  const messages = (await import("../routes/messages.js")).default;
  const apps = (await import("../modules/applications/applications.routes.js")).default;
  const { errorHandler } = await import("../middleware/errors.js");
  const app = express();
  app.use(express.json());
  app.use("/api/crm", crm);
  app.use("/api/messages", messages);
  app.use("/api/applications", apps);
  app.use(errorHandler);
  return app;
}

beforeEach(() => {
  process.env.JWT_SECRET = SECRET;
  queryMock.mockReset();
  queryMock.mockImplementation(answerBySql([usersRule()]));
});

describe("CRM reads are silo-scoped", () => {
  it("GET /api/crm/leads filters crm_leads by the caller's silo", async () => {
    const app = await buildApp();
    const res = await request(app).get("/api/crm/leads").set("Authorization", `Bearer ${staffToken()}`);
    expect(res.status).toBe(200);
    const q = callsMatching(queryMock, /FROM crm_leads/);
    expect(q).toHaveLength(1);
    expect(String(q[0][0])).toContain("WHERE silo = $1");
    expect(q[0][1]).toEqual(["BI"]);
  });

  it("GET /api/crm/contacts/:id/applications only lists applications in the caller's silo", async () => {
    const app = await buildApp();
    const res = await request(app).get(`/api/crm/contacts/${CONTACT_ID}/applications`).set("Authorization", `Bearer ${staffToken()}`);
    expect(res.status).toBe(200);
    const q = callsMatching(queryMock, /FROM applications\s+WHERE contact_id::text = \$1/);
    expect(String(q[0][0])).toContain("AND silo = $2");
    expect(q[0][1]).toEqual([CONTACT_ID, "BI"]);
  });

  it("GET /api/crm/contacts/:id/stage-events only reads applications in the caller's silo", async () => {
    const app = await buildApp();
    const res = await request(app).get(`/api/crm/contacts/${CONTACT_ID}/stage-events`).set("Authorization", `Bearer ${staffToken()}`);
    expect(res.status).toBe(200);
    const q = callsMatching(queryMock, /FROM application_stage_events/);
    expect(String(q[0][0])).toContain("contact_id = $1::uuid AND silo = $2");
    expect(q[0][1]).toEqual([CONTACT_ID, "BI"]);
  });

  it("GET /api/messages?contactId= only returns messages for a contact in the caller's silo", async () => {
    const app = await buildApp();
    const res = await request(app).get(`/api/messages?contactId=${CONTACT_ID}`).set("Authorization", `Bearer ${staffToken()}`);
    expect(res.status).toBe(200);
    const q = callsMatching(queryMock, /FROM communications_messages/);
    expect(String(q[0][0])).toContain("SELECT c.id FROM contacts c WHERE c.id::text = $1::text AND c.silo = $2");
    expect(q[0][1]).toEqual([CONTACT_ID, "BI"]);
  });
});

describe("debug views are Admin-only and silo-filtered", () => {
  for (const path of ["/api/applications/dup-debug?q=acme", "/api/applications/phone-debug?phone=5555550123"]) {
    it(`${path.split("?")[0]} rejects Staff with 403`, async () => {
      const app = await buildApp();
      const res = await request(app).get(path).set("Authorization", `Bearer ${staffToken()}`);
      expect(res.status).toBe(403);
      expect(callsMatching(queryMock, /FROM applications a/)).toHaveLength(0);
    });
  }

  it("dup-debug for an Admin filters by the resolved silo", async () => {
    const app = await buildApp();
    const res = await request(app).get("/api/applications/dup-debug?q=acme").set("Authorization", `Bearer ${adminToken()}`).set("X-Silo", "SLF");
    expect(res.status).toBe(200);
    const q = callsMatching(queryMock, /FROM applications a LEFT JOIN contacts c/);
    expect(String(q[0][0])).toContain("AND a.silo = $2");
    expect(q[0][1]).toEqual(["%acme%", "SLF"]);
  });

  it("phone-debug for an Admin filters by the resolved silo", async () => {
    const app = await buildApp();
    const res = await request(app).get(`/api/applications/phone-debug?phone=5555550123&ids=${APP_ID}`).set("Authorization", `Bearer ${adminToken()}`);
    expect(res.status).toBe(200);
    const q = callsMatching(queryMock, /FROM applications a/);
    expect(q).toHaveLength(2);
    for (const call of q) {
      expect(String(call[0])).toContain("a.silo = $2");
      expect((call[1] as unknown[])[1]).toBe("BF");
    }
  });
});

describe("per-application routes return 404 for another silo's record", () => {
  // The application lives in BF; the staff caller is BI-only.
  function appInBf() {
    queryMock.mockImplementation(answerBySql([
      usersRule(),
      [/SELECT silo FROM applications WHERE id::text/, { rows: [{ silo: "BF" }] }],
      [/SELECT id, banking_completed_at/, (_sql: string, params?: unknown[]) =>
        // a row unless the query names a silo other than the record's
        (params?.[1] === undefined || params?.[1] === "BF" ? { rows: [{ id: APP_ID, banking_completed_at: null }] } : { rows: [] })],
    ]));
  }

  const cases: Array<[string, string, Record<string, unknown> | undefined]> = [
    ["post", `/api/applications/${APP_ID}/reject`, { reasonCodes: ["credit"] }],
    ["post", `/api/applications/${APP_ID}/resend-signing`, {}],
    ["get", `/api/applications/${APP_ID}/banking-analysis`, undefined],
    ["get", `/api/applications/${APP_ID}/task-status`, undefined],
    ["get", `/api/applications/${APP_ID}/sent-lenders`, undefined],
  ];

  for (const [method, path, body] of cases) {
    it(`${method.toUpperCase()} ${path.replace(APP_ID, ":id")} -> 404 across silos, with no side effects`, async () => {
      appInBf();
      const app = await buildApp();
      const req = (request(app) as any)[method](path).set("Authorization", `Bearer ${staffToken()}`);
      const res = body ? await req.send(body) : await req;
      expect(res.status).toBe(404);
      expect(callsMatching(queryMock, /UPDATE applications/)).toHaveLength(0);
      expect(callsMatching(queryMock, /INSERT INTO application_rejection_reasons/)).toHaveLength(0);
      expect(callsMatching(queryMock, /FROM application_packages/)).toHaveLength(0);
      expect(callsMatching(queryMock, /FROM communications_messages/)).toHaveLength(0);
    });
  }

  it("the same-silo caller still reaches sent-lenders", async () => {
    appInBf();
    const app = await buildApp();
    const res = await request(app).get(`/api/applications/${APP_ID}/sent-lenders`).set("Authorization", `Bearer ${adminToken()}`);
    expect(res.status).toBe(200);
    expect(callsMatching(queryMock, /FROM application_packages/)).toHaveLength(1);
  });
});
