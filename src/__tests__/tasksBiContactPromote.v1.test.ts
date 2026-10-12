// BF_SERVER_TASKS_BI_CONTACT_PROMOTE_v1 - creating a task/call/email on a BI
// outreach lead (bi_contacts, which tasks.contact_id cannot FK-reference)
// promotes the lead into the main CRM contacts table (silo='BI') and attaches
// the task to that real contact, instead of failing with contact_not_found.
import express from "express";
import jwt from "jsonwebtoken";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { answerBySql, callsMatching, sqlText } from "./helpers/answerBySql.js";

const h = vi.hoisted(() => ({ queryMock: vi.fn(), fetchBi: vi.fn() }));
vi.mock("../db.js", async () => {
  const actual = await vi.importActual<typeof import("../db.js")>("../db.js");
  return { ...actual, pool: { query: h.queryMock } };
});
vi.mock("../services/biOutreach.js", async (orig) => ({ ...(await orig<typeof import("../services/biOutreach.js")>()), fetchBiOutreachContact: h.fetchBi }));
vi.mock("../modules/o365/todoSync.js", () => ({ mirrorTaskToTodo: async () => undefined }));

import tasksRouter from "../routes/tasks.js";

const LEAD_ID = "b1000000-0000-4000-8000-000000000001";
const EXISTING_BI_CONTACT = "b1000000-0000-4000-8000-000000000002";
const PROMOTED = "b1000000-0000-4000-8000-000000000003";
const LEAD = { full_name: "Lena Lead", email: "Lena@Outreach.test", phone_e164: "+15875550188", company_id: null };
const DUPE_SQL = /SELECT id FROM contacts\s+WHERE silo = 'BI'/;
const PROMOTE_SQL = /INSERT INTO contacts \(name, email, phone, silo\)/;

const app = express();
app.use(express.json());
app.use("/api/tasks", tasksRouter);
const staff = () => "Bearer " + jwt.sign({ sub: "11111111-1111-4111-8111-111111111111", role: "Staff", tokenVersion: 0, tv: 0 }, process.env.JWT_SECRET as string, { algorithm: "HS256" });
const create = () => request(app).post("/api/tasks").set("Authorization", staff()).set("x-silo", "BF").send({ title: "Call Lena", type: "CALL", contact_id: LEAD_ID });
const insertedTask = () => callsMatching(h.queryMock, /INSERT INTO tasks/)[0]?.[1] as unknown[] | undefined;

let dupe: string | null;
beforeEach(() => {
  dupe = null;
  h.fetchBi.mockReset();
  h.fetchBi.mockResolvedValue({ status: "ok", lead: LEAD });
  h.queryMock.mockReset();
  h.queryMock.mockImplementation(answerBySql([
    [/bi_contacts/, new Error('relation "bi_contacts" does not exist')],
    [/SELECT silo FROM contacts WHERE id::text = \$1/, { rows: [], rowCount: 0 }],
    [DUPE_SQL, () => (dupe ? { rows: [{ id: dupe }], rowCount: 1 } : { rows: [], rowCount: 0 })],
    [PROMOTE_SQL, { rows: [{ id: PROMOTED }], rowCount: 1 }],
    [/INSERT INTO tasks/, { rows: [{ id: "task-1" }], rowCount: 1 }],
  ]));
});

describe("BI outreach lead promotion on task create", () => {
  it("looks up the id as a BI outreach lead when it is not a main contact", async () => {
    const r = await create();
    expect(r.status).toBe(200);
    // BF_SERVER_v789_BI_OUTREACH_VIA_API - bi_contacts is not in this database; the lead is read from BI-Server.
    expect(h.fetchBi).toHaveBeenCalledWith(LEAD_ID);
    expect(callsMatching(h.queryMock, /FROM bi_contacts/)).toHaveLength(0);
  });

  it("reuses an existing BI contact matched by phone/email before creating one", async () => {
    dupe = EXISTING_BI_CONTACT;
    const r = await create();
    expect(r.status).toBe(200);
    const [d] = callsMatching(h.queryMock, DUPE_SQL);
    expect(sqlText(d[0])).toContain("lower(email) = lower($2)");
    expect(d[1]).toEqual(["+15875550188", "Lena@Outreach.test"]);
    expect(callsMatching(h.queryMock, PROMOTE_SQL)).toHaveLength(0);
    expect(insertedTask()?.[9]).toBe(EXISTING_BI_CONTACT);
    expect(insertedTask()?.[0]).toBe("BI");
  });

  it("creates the promoted contact with silo BI and re-points the task to it", async () => {
    const r = await create();
    expect(r.status).toBe(200);
    const [ins] = callsMatching(h.queryMock, PROMOTE_SQL);
    expect(sqlText(ins[0])).toContain("VALUES ($1,$2,$3,'BI')");
    expect(ins[1]).toEqual(["Lena Lead", "Lena@Outreach.test", "+15875550188"]);
    expect(insertedTask()?.[9]).toBe(PROMOTED);
    expect(insertedTask()?.[0]).toBe("BI");
  });

  it("still 400s contact_not_found only when the id is in neither table", async () => {
    h.fetchBi.mockResolvedValue({ status: "not_found" });
    const r = await create();
    expect(r.status).toBe(400);
    expect(r.body.error.message).toBe("contact_not_found");
    expect(callsMatching(h.queryMock, /INSERT INTO/)).toHaveLength(0);

    h.fetchBi.mockResolvedValue({ status: "error" });
    const down = await create();
    expect(down.status).toBe(502);
    expect(down.body.error.message).toBe("bi_contact_lookup_failed");
  });
});
