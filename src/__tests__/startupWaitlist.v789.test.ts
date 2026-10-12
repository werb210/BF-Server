// BF_SERVER_v789_WAITLIST_NO_TAKEOVER - /api/crm/startup-waitlist must never overwrite an
// existing contact's name/email/phone (only empty fields are filled), matches only inside the
// request silo, and leaves both contacts alone when the email and phone belong to different ones.
import express from "express";
import jwt from "jsonwebtoken";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { answerBySql, callsMatching } from "./helpers/answerBySql.js";

const { queryMock, logWarnMock } = vi.hoisted(() => ({ queryMock: vi.fn(), logWarnMock: vi.fn() }));

vi.mock("../db", async () => {
  const actual = await vi.importActual<typeof import("../db.js")>("../db");
  return { ...actual, pool: { query: queryMock } };
});
vi.mock("../observability/logger.js", async () => {
  const actual = await vi.importActual<typeof import("../observability/logger.js")>("../observability/logger.js");
  return { ...actual, logWarn: logWarnMock };
});

const SECRET = "test-secret-v789-waitlist";
const ADMIN_ID = "00000000-0000-0000-0000-0000000000a1";
const CONTACT_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CONTACT_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const userRow = { rows: [{ id: ADMIN_ID, email: null, role: "Admin", silo: "BF", silos: ["BF", "BI"] }] };

function token(): string {
  return jwt.sign({ id: ADMIN_ID, role: "Admin", capabilities: ["crm:read", "crm:write"] }, SECRET, { algorithm: "HS256" });
}

async function buildApp() {
  const router = (await import("../routes/crm.js")).default;
  const app = express();
  app.use(express.json());
  app.use("/api/crm", router);
  return app;
}

function post(app: express.Express, body: Record<string, unknown>, silo?: string) {
  const r = request(app).post("/api/crm/startup-waitlist").set("Authorization", `Bearer ${token()}`);
  if (silo) r.set("X-Silo", silo);
  return r.send(body);
}

describe("POST /api/crm/startup-waitlist (v789)", () => {
  beforeEach(() => {
    process.env.JWT_SECRET = SECRET;
    queryMock.mockReset();
    logWarnMock.mockReset();
  });

  it("an existing contact's name, email and phone are never overwritten (takeover attempt)", async () => {
    queryMock.mockImplementation(answerBySql([
      [/FROM users/, userRow],
      // the victim's email matches contact A; the attacker's phone matches nobody
      [/from contacts\s+where silo = \$3/, { rows: [{ id: CONTACT_A, email_match: true, phone_match: false }] }],
    ]));
    const app = await buildApp();
    const res = await post(app, { name: "Mallory Attacker", email: "victim@example.com", phone: "+15555550123" });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, id: CONTACT_A, created: false });

    const updates = callsMatching(queryMock, /update contacts\s+set name/i);
    expect(updates).toHaveLength(1);
    const sql = String(updates[0][0]);
    // only null/empty fields are filled
    expect(sql).toContain("name       = case when coalesce(name, '') = '' then $2 else name end");
    expect(sql).toContain("email      = case when coalesce(email, '') = '' then $5 else email end");
    expect(sql).toContain("phone      = case when coalesce(phone, '') = '' then $6 else phone end");
    expect(sql).not.toMatch(/name = coalesce\(\$2, name\)/);
    expect(sql).not.toMatch(/email = coalesce\(\$3, email\)/);
    expect(sql).toContain("where id = $1 and silo = $7");
    expect(updates[0][1]).toEqual([CONTACT_A, "Mallory Attacker", "Mallory", "Attacker", "victim@example.com", "+15555550123", "BF"]);
    expect(callsMatching(queryMock, /insert into contacts/i)).toHaveLength(0);
  });

  it("email matches one contact and phone another: neither is changed, it is logged, ok is returned", async () => {
    queryMock.mockImplementation(answerBySql([
      [/FROM users/, userRow],
      [/from contacts\s+where silo = \$3/, { rows: [
        { id: CONTACT_A, email_match: true, phone_match: false },
        { id: CONTACT_B, email_match: false, phone_match: true },
      ] }],
    ]));
    const app = await buildApp();
    const res = await post(app, { name: "Someone", email: "a@example.com", phone: "+15555550199", consent: true });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, created: false, conflict: true });
    expect(callsMatching(queryMock, /update contacts/i)).toHaveLength(0);
    expect(callsMatching(queryMock, /insert into contacts/i)).toHaveLength(0);
    expect(logWarnMock).toHaveBeenCalledWith("crm.startup_waitlist.contact_conflict", expect.objectContaining({
      emailContactId: CONTACT_A, phoneContactId: CONTACT_B, silo: "BF",
    }));
  });

  it("email and phone both on the same contact is a normal match, not a conflict", async () => {
    queryMock.mockImplementation(answerBySql([
      [/FROM users/, userRow],
      [/from contacts\s+where silo = \$3/, { rows: [{ id: CONTACT_A, email_match: true, phone_match: true }] }],
    ]));
    const app = await buildApp();
    const res = await post(app, { name: "Jane", email: "a@example.com", phone: "+15555550199" });
    expect(res.body).toMatchObject({ ok: true, id: CONTACT_A, created: false });
    expect(res.body.conflict).toBeUndefined();
  });

  it("the match is scoped to the request silo, and a new lead lands in that silo", async () => {
    queryMock.mockImplementation(answerBySql([
      [/FROM users/, userRow],
      [/from contacts\s+where silo = \$3/, { rows: [] }],
      [/insert into contacts/i, { rows: [{ id: CONTACT_B }] }],
    ]));
    const app = await buildApp();
    const res = await post(app, { name: "Bea Lead", email: "bea@example.com" }, "BI");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, id: CONTACT_B, created: true });

    const lookup = callsMatching(queryMock, /from contacts\s+where silo = \$3/);
    expect(lookup).toHaveLength(1);
    expect((lookup[0][1] as unknown[])[2]).toBe("BI");
    const ins = callsMatching(queryMock, /insert into contacts/i);
    expect((ins[0][1] as unknown[])[5]).toBe("BI");
    const tag = callsMatching(queryMock, /SET tags = /);
    expect(String(tag[0][0])).toContain("WHERE id = $1 AND silo = $4");
    expect((tag[0][1] as unknown[])[3]).toBe("BI");
  });
});
