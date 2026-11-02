// BF_SERVER_v869_SETTINGS_PACK_NEVER_LOG - addresses and domains whose mail is never logged or auto-filed.
import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";
import { answerBySql, callsMatching } from "../../__tests__/helpers/answerBySql.js";

const h = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("../../db.js", async () => {
  const actual = await vi.importActual<typeof import("../../db.js")>("../../db.js");
  return { ...actual, pool: { query: h.query }, db: { query: h.query }, runQuery: h.query, dbQuery: h.query, query: h.query };
});

import { matcher, parseEntry } from "../neverLog.js";

const LIST = [{ value: "lawyer@firm.test", kind: "email" }, { value: "family.test", kind: "domain" }];
const ADMIN = "11111111-1111-4111-8111-111111111111";
const STAFF = "22222222-2222-4222-8222-222222222222";
const tok = (id: string) => jwt.sign({ sub: id, id, role: "Staff", tokenVersion: 0, tv: 0 }, String(process.env.JWT_SECRET));
let audits: unknown[];

beforeEach(async () => {
  h.query.mockReset(); audits = [];
  (await import("../neverLog.js")).clearNeverLogCache();
  h.query.mockImplementation(answerBySql([
    [/FROM users\s+WHERE id = \$1|FROM users WHERE id/, (_s: string, p?: unknown[]) => ({ rows: [{ id: p?.[0], role: p?.[0] === ADMIN ? "Admin" : "Staff", active: true, status: "ACTIVE", token_version: 0, disabled: false }] })],
    [/SELECT value, kind FROM never_log_entries/, { rows: LIST }],
    [/INSERT INTO never_log_entries/, (_s: string, p?: unknown[]) => ({ rows: p?.[0] === "family.test" ? [] : [{ id: "e1", value: p?.[0], kind: p?.[1], note: p?.[2] }] })],
    [/insert into audit_events/i, (_s: string, p?: unknown[]) => { audits.push(p?.[4]); return { rows: [] }; }],
    [/FROM contacts\s+WHERE silo = \$1/, { rows: [{ id: "c1" }] }],
    [/SELECT silo FROM users/, { rows: [{ silo: "BF" }] }],
  ]));
});

describe("the list", () => {
  it("accepts an address or a domain, and refuses anything else", () => {
    expect(parseEntry(" Lawyer@Firm.test ")).toEqual({ ok: true, value: "lawyer@firm.test", kind: "email" });
    expect(parseEntry("@Family.test")).toEqual({ ok: true, value: "family.test", kind: "domain" });
    expect(parseEntry("*.family.test")).toEqual({ ok: true, value: "family.test", kind: "domain" });
    expect(parseEntry("not a thing").ok).toBe(false);
    expect(parseEntry("").ok).toBe(false);
  });

  it("matches the address, the domain and its subdomains only", () => {
    const m = matcher(LIST as any);
    expect(m("LAWYER@firm.test")).toBe(true);
    expect(m("other@firm.test")).toBe(false);
    expect(m("mom@family.test")).toBe(true);
    expect(m("mom@mail.family.test")).toBe(true);
    expect(m("mom@notfamily.test")).toBe(false);
  });
});

describe("mail on the list is not logged", () => {
  it("Outlook sent items skip listed recipients and colleagues at the sender's own domain", async () => {
    const { logSentMessage } = await import("../../modules/o365/sentItemsLog.js");
    const { pool } = await import("../../db.js");
    const written = await logSentMessage(pool as any, "user-1", {
      id: "m1", subject: "Hi", from: { emailAddress: { address: "jane@acme-capital.ca" } },
      toRecipients: [{ emailAddress: { address: "mom@family.test" } }, { emailAddress: { address: "raj@acme-capital.ca" } }],
    });
    expect(written).toBe(0);
    expect(callsMatching(h.query, /INSERT INTO crm_email_log/)).toHaveLength(0);
  });

  it("inbound attachments from a listed sender are not auto-filed", async () => {
    const { fileInboundAttachments } = await import("../../services/contactDocuments.js");
    const { pool } = await import("../../db.js");
    const graph = { fetch: vi.fn() } as any;
    const r = await fileInboundAttachments({ pool: pool as any, graph, base: "/me", silo: "BF", message: { id: "m1", hasAttachments: true, from: { emailAddress: { address: "lawyer@firm.test" } } } });
    expect(r).toEqual({ filed: 0, contactId: null, reason: "never_log" });
    expect(graph.fetch).not.toHaveBeenCalled();
  });
});

describe("Settings > Never log", () => {
  it("staff can read it; Admins add and remove entries (audited); duplicates are refused", async () => {
    const router = (await import("../../routes/neverLog.js")).default;
    const a = express();
    a.use(express.json());
    a.use("/api/never-log", router);
    expect((await request(a).get("/api/never-log").set("Authorization", `Bearer ${tok(STAFF)}`)).status).toBe(200);
    expect((await request(a).post("/api/never-log").set("Authorization", `Bearer ${tok(STAFF)}`).send({ value: "x@y.test" })).status).toBe(403);
    const bad = await request(a).post("/api/never-log").set("Authorization", `Bearer ${tok(ADMIN)}`).send({ value: "nope" });
    expect(bad.status).toBe(400);
    const ok = await request(a).post("/api/never-log").set("Authorization", `Bearer ${tok(ADMIN)}`).send({ value: "hr@acme-capital.ca", note: "HR" });
    expect(ok.status).toBe(201);
    expect(ok.body.entry).toMatchObject({ value: "hr@acme-capital.ca", kind: "email" });
    expect(audits).toContain("never_log.added");
    const dup = await request(a).post("/api/never-log").set("Authorization", `Bearer ${tok(ADMIN)}`).send({ value: "family.test" });
    expect(dup.status).toBe(409);
  });
});
