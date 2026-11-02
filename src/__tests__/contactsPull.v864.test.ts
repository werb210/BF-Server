// BF_SERVER_v864_CONTACTS_PULL_FIX - "Sync contacts from Outlook" end to end with a fake Graph and a database that
// answers by SQL content: links CRM contacts by ANY Outlook email, fills a missing phone on either side so caller ID
// resolves both ways, and reports a missing connection or permission instead of "linked 0".
import { describe, it, expect, vi, beforeEach } from "vitest";

const { graphFor } = vi.hoisted(() => ({ graphFor: vi.fn() }));
vi.mock("../modules/o365/graphClient.js", () => ({ getGraphForUser: graphFor }));

import express from "express";
import request from "supertest";
import { pullOutlookContactsForUser, outlookPhone, toCrmPhone } from "../modules/o365/contactPull.js";

const USER = "00000000-0000-0000-0000-0000000000aa";

type Crm = { id: string; owner_id: string; email: string; phone: string | null; outlook_contact_id: string | null; silo: string };

function fakeDb(rows: Crm[]) {
  return {
    rows,
    query: vi.fn(async (sql: string, p: any[]) => {
      if (/UPDATE contacts SET outlook_contact_id = \$1/.test(sql)) {
        const [oid, owner, emails] = p;
        const hit = rows.filter((r) => r.owner_id === owner && emails.includes(r.email.toLowerCase()) && !r.outlook_contact_id);
        hit.forEach((r) => { r.outlook_contact_id = oid; });
        return { rowCount: hit.length, rows: hit.map((r) => ({ id: r.id, phone: r.phone })) };
      }
      if (/UPDATE contacts SET phone = \$2/.test(sql)) {
        const r = rows.find((x) => x.id === p[0] && !(x.phone ?? "").trim());
        if (r) r.phone = p[1];
        return { rowCount: r ? 1 : 0, rows: [] };
      }
      // Caller ID lookup, same rule as routes/voiceCalls.ts: last 10 digits of contacts.phone in the call's silo.
      if (/right\(regexp_replace/.test(sql)) {
        const want = String(p[0]);
        const r = rows.find((x) => x.silo === p[1] && (x.phone ?? "").replace(/\D/g, "").slice(-10) === want);
        return { rows: r ? [{ id: r.id }] : [] };
      }
      throw new Error("unexpected SQL " + sql.slice(0, 80));
    }),
  } as any;
}

function fakeGraph(pages: any[], opts: { status?: number } = {}) {
  const patches: Array<{ path: string; body: any }> = [];
  const store: Record<string, any> = {};
  pages.flatMap((pg) => pg.value).forEach((c: any) => { store[c.id] = c; });
  return {
    patches,
    store,
    fetch: vi.fn(async (path: string, init?: RequestInit) => {
      if (init?.method === "PATCH") {
        const body = JSON.parse(String(init.body));
        patches.push({ path, body });
        const id = decodeURIComponent(path.split("/").pop()!);
        store[id] = { ...store[id], ...body };
        return new Response("{}", { status: 200 });
      }
      if (opts.status) return new Response("Access is denied", { status: opts.status });
      const page = path.includes("skiptoken=2") ? pages[1] : pages[0];
      return new Response(JSON.stringify(page), { status: 200, headers: { "Content-Type": "application/json" } });
    }),
  };
}

const PAGES = [
  {
    value: [
      { id: "O1", emailAddresses: [{ address: "other@x.com" }, { address: "Walter@AgriCo.ca" }], mobilePhone: "(519) 702-3904", businessPhones: [] },
      { id: "O2", emailAddresses: [{ address: "sam@client.com" }], businessPhones: [], mobilePhone: null },
      { id: "O3", emailAddresses: [], mobilePhone: "4035550000" },
    ],
    "@odata.nextLink": "https://graph.microsoft.com/v1.0/me/contacts?$skiptoken=2",
  },
  { value: [{ id: "O4", emailAddresses: [{ address: "notmine@x.com" }], mobilePhone: "7805550199" }] },
];

describe("pullOutlookContactsForUser (v864)", () => {
  beforeEach(() => graphFor.mockReset());

  it("links by any email, fills missing phones both ways, never touches other owners", async () => {
    const db = fakeDb([
      { id: "c-walter", owner_id: USER, email: "walter@agrico.ca", phone: null, outlook_contact_id: null, silo: "BF" },
      { id: "c-sam", owner_id: USER, email: "sam@client.com", phone: "+14035551234", outlook_contact_id: null, silo: "BF" },
      { id: "c-other", owner_id: "someone-else", email: "notmine@x.com", phone: null, outlook_contact_id: null, silo: "BF" },
    ]);
    const graph = fakeGraph(PAGES);
    graphFor.mockResolvedValue(graph);
    const r = await pullOutlookContactsForUser(db, USER);
    expect(r).toMatchObject({ connected: true, scanned: 4, linked: 2, phonesAddedToCrm: 1, phonesAddedToOutlook: 1 });
    expect(db.rows.find((x: Crm) => x.id === "c-walter")).toMatchObject({ outlook_contact_id: "O1", phone: "+15197023904" });
    expect(db.rows.find((x: Crm) => x.id === "c-other").outlook_contact_id).toBeNull();
    expect(graph.patches).toEqual([{ path: "/me/contacts/O2", body: { businessPhones: ["+14035551234"] } }]);
    // The second page was followed.
    expect(graph.fetch.mock.calls.some((c: any[]) => String(c[0]).includes("skiptoken=2"))).toBe(true);

    // Caller ID now resolves both ways.
    const inbound = await db.query("SELECT id FROM contacts WHERE silo = $2 AND right(regexp_replace(phone, '[^0-9]', '', 'g'), 10) = $1", ["5197023904", "BF"]);
    expect(inbound.rows[0]?.id).toBe("c-walter"); // Outlook number -> Boreal caller ID finds Walter
    expect(outlookPhone(graph.store.O2)).toBe("+14035551234"); // CRM number -> Outlook (phone caller ID) has Sam
  });

  it("a second run is a no-op and keeps existing numbers", async () => {
    const db = fakeDb([{ id: "c1", owner_id: USER, email: "sam@client.com", phone: "+14035551234", outlook_contact_id: "O2", silo: "BF" }]);
    graphFor.mockResolvedValue(fakeGraph(PAGES));
    const r = await pullOutlookContactsForUser(db, USER);
    expect(r).toMatchObject({ linked: 0, phonesAddedToCrm: 0, phonesAddedToOutlook: 0 });
  });

  it("reports a missing connection and a refused permission", async () => {
    graphFor.mockResolvedValue(null);
    expect(await pullOutlookContactsForUser(fakeDb([]), USER)).toMatchObject({ connected: false, linked: 0 });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    graphFor.mockResolvedValue(fakeGraph(PAGES, { status: 403 }));
    expect(await pullOutlookContactsForUser(fakeDb([]), USER)).toMatchObject({ connected: true, error: "missing_permission" });
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("normalises numbers the way the CRM stores them", () => {
    expect(toCrmPhone("(519) 702-3904")).toBe("+15197023904");
    expect(toCrmPhone("1-519-702-3904")).toBe("+15197023904");
    expect(outlookPhone({ businessPhones: ["123"], homePhones: ["780 555 0199"] })).toBe("780 555 0199");
  });
});

describe("POST /api/o365/contacts/pull (v864)", () => {
  it("answers 412 with a clear message when Microsoft 365 is not connected", async () => {
    graphFor.mockResolvedValue(null);
    vi.doMock("../middleware/auth.js", () => ({ requireAuth: (req: any, _res: any, next: any) => { req.user = { id: USER }; next(); } }));
    vi.doMock("../db.js", () => ({ pool: { query: vi.fn() }, runQuery: vi.fn() }));
    const router = (await import("../routes/o365.js")).default;
    const app = express();
    app.use(express.json());
    app.use("/api/o365", router);
    const res = await request(app).post("/api/o365/contacts/pull").send({});
    expect(res.status).toBe(412);
    expect(res.body.message).toMatch(/Connect Microsoft 365/);
  });
});
