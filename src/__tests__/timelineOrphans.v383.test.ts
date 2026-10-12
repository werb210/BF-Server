// BF_SERVER_TIMELINE_ORPHANS_v383
import request from "supertest";
import { beforeEach, describe, it, expect, vi } from "vitest";
import { answerBySql, callsMatching } from "./helpers/answerBySql.js";
import { mountRouter, staffToken } from "./helpers/staffRouterApp.js";

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));
vi.mock("../db.js", async () => ({ ...(await vi.importActual<any>("../db.js")), pool: { query: queryMock }, dbQuery: queryMock }));

const CONTACT = "c0c0c0c0-0000-4000-8000-000000000383";

beforeEach(() => {
  queryMock.mockReset().mockImplementation(answerBySql([]));
});

describe("emails and SMS with no matching contact still reach the contact", () => {
  it("messages fall back to the contact's phones on the last 10 digits", async () => {
    const res = await request(mountRouter((await import("../routes/crm.js")).default, "/api/crm"))
      .get(`/api/crm/contacts/${CONTACT}/timeline`).set("Authorization", `Bearer ${staffToken()}`).set("X-Silo", "BF");
    expect(res.status).toBe(200);
    const [call] = callsMatching(queryMock, /FROM crm_notes/);
    const tl = String(call[0]);
    expect(call[1]).toEqual([CONTACT, "BF"]);
    expect(tl).toContain("m.contact_id = $1 OR (m.contact_id IS NULL AND EXISTS (");
    expect(tl).toContain("CROSS JOIN LATERAL (VALUES (c.phone), (c.secondary_phone)) AS cp(v)");
    for (const col of ["m.phone_number", "m.from_number", "m.to_number"]) {
      expect(tl).toContain(`right(regexp_replace(coalesce(${col}, ''), '[^0-9]', '', 'g'), 10)`);
    }
    expect(tl).toContain("length(regexp_replace(coalesce(cp.v, ''), '[^0-9]', '', 'g')) >= 10");
    expect(tl).toContain("AND (m.silo = $2 OR m.silo IS NULL)");
  });

  it("emails fall back to the contact's addresses in the same silo", async () => {
    queryMock.mockImplementation(answerBySql([[/FROM crm_email_log e/, { rows: [{ id: "e1", subject: "Orphan" }] }]]));
    const res = await request(mountRouter((await import("../routes/crm.js")).default, "/api/crm"))
      .get(`/api/crm/contacts/${CONTACT}/emails`).set("Authorization", `Bearer ${staffToken()}`);
    expect(res.status).toBe(200);
    expect(res.body.items).toEqual([{ id: "e1", subject: "Orphan" }]);
    const [call] = callsMatching(queryMock, /FROM crm_email_log e/);
    const crm = String(call[0]);
    expect(call[1]).toEqual([CONTACT]);
    expect(crm).toContain("e.contact_id IS NULL AND EXISTS (");
    expect(crm).toContain("CROSS JOIN LATERAL (VALUES (c.email), (c.secondary_email)) AS ce(v)");
    expect(crm).toContain("AND e.silo = c.silo");
    expect(crm).toContain("NULLIF(lower(trim(ce.v)), '') IS NOT NULL");
    expect(crm).toContain("unnest(array_prepend(e.from_address, e.to_addresses || e.cc_addresses))");
  });
});
