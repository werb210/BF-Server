// BF_SERVER_v856_CRM_UNIFY - people from applications and the advisors form, duplicate rules for same-name people,
// placeholder survivors, merge chains, collapsed drafts and the one-call-task rule. Database faked by SQL content.
import { describe, expect, it } from "vitest";
import { normalizeTag, tagKind } from "../tags.js";
import { companyNamesSimilar, isPlaceholderName, suggestSurvivor } from "../duplicates.js";
import { advisorEntries, advisorType, syncApplicationPeople } from "../peopleSync.js";
import { resolveContactSurvivor } from "../mergeChain.js";
import { dedupeStageEvents } from "../contactPanel.js";

type Row = Record<string, any>;
type Handler = [RegExp, (params: any[]) => Row[]];
function fakeDb(handlers: Handler[]) {
  const calls: Array<{ sql: string; params: any[] }> = [];
  return {
    calls,
    query: async (sql: string, params: any[] = []) => {
      calls.push({ sql, params });
      for (const [re, fn] of handlers) if (re.test(sql)) { const rows = fn(params); return { rows, rowCount: rows.length }; }
      return { rows: [], rowCount: 0 };
    },
  };
}

describe("advisor and partner tags", () => {
  it("maps the old advisor tags onto the shared core list", () => {
    expect(normalizeTag("Accountant/advisor")).toBe("accountant");
    expect(normalizeTag("Lawyer/advisor")).toBe("lawyer");
    expect(normalizeTag("Insurance/advisor")).toBe("insurance");
    expect(normalizeTag("A/R Credit Insurance/advisor")).toBe("ar_credit_insurance");
    expect(normalizeTag("A/R Credit Insurance")).toBe("ar_credit_insurance");
    expect(tagKind("insurance")).toBe("core");
    expect(tagKind("ar_credit_insurance")).toBe("core");
    expect(tagKind("partner")).toBe("system");
    expect(tagKind("guarantor")).toBe("system");
  });
  it("reads the advisors form with the tag, role and type for each advisor", () => {
    const list = advisorEntries({ advisors: {
      cpa: { firm: "Numbers LLP", contact: "Ann Count", email: "ANN@numbers.ca", phone: "403-555-0101" },
      attorney: { firm: "Law Co", contact: "", email: "", phone: "" },
      insurance: { contact: "Ivan Insure" },
      ar_credit_insurance: { firm: "", contact: "", email: "", phone: "" },
    } });
    expect(list).toHaveLength(3);
    expect(list[0]).toMatchObject({ firm: "Numbers LLP", name: "Ann Count", email: "ann@numbers.ca", type: { tag: "accountant", role: "accountant" } });
    expect(list[1]).toMatchObject({ firm: "Law Co", name: null, type: { tag: "lawyer", role: "lawyer", label: "Lawyer" } });
    expect(list[2]!.type).toMatchObject({ tag: "insurance", role: "advisor", label: "Insurance" });
    expect(advisorType("ar_credit_insurance")).toMatchObject({ tag: "ar_credit_insurance", role: "advisor" });
    expect(advisorType("banker")).toMatchObject({ tag: "advisor", role: "advisor" });
  });
});

describe("duplicates of the same person and company", () => {
  it("treats a shortened company name as similar", () => {
    expect(companyNamesSimilar("Big Broker", "Big Brokerage")).toBe(true);
    expect(companyNamesSimilar("Big Broker Inc.", "Big Brokerage LLC")).toBe(true);
    expect(companyNamesSimilar("Big Broker", "Big Brokerage Partners Of Canada")).toBe(false);
    expect(companyNamesSimilar("Acme", "Acmeco")).toBe(false); // too short to judge
  });
  it("keeps the real record over a placeholder, then the one with applications, then the oldest", () => {
    expect(isPlaceholderName("Unknown (application started)")).toBe(true);
    expect(isPlaceholderName("Unknown")).toBe(true);
    expect(isPlaceholderName("Todd Werboweski")).toBe(false);
    expect(suggestSurvivor([
      { id: "p", name: "Unknown (application started)", application_count: 3, created_at: "2026-01-01" },
      { id: "r", name: "Sean Dwyer", application_count: 0, created_at: "2026-02-01" },
    ])).toBe("r");
    expect(suggestSurvivor([
      { id: "a", name: "Todd Werboweski", application_count: 0, created_at: "2026-01-01" },
      { id: "b", name: "Todd Werboweski", application_count: 1, created_at: "2026-03-01" },
    ])).toBe("b");
  });
});

describe("merge chains", () => {
  const contacts: Record<string, Row> = {
    walter1: { id: "walter1", merged_into_id: "walter2", status: "archived", name: "Walter De Kruyff" },
    walter2: { id: "walter2", merged_into_id: "walter3", status: "archived", name: "Walter De Kruyff" },
    walter3: { id: "walter3", merged_into_id: null, status: "active", name: "Walter De Kruyff" },
    old: { id: "old", merged_into_id: null, status: "archived", name: "Old" },
    loopA: { id: "loopA", merged_into_id: "loopB", status: "archived", name: "A" },
    loopB: { id: "loopB", merged_into_id: "loopA", status: "archived", name: "B" },
  };
  const db = fakeDb([
    [/merged_into_id::text AS merged_into_id/, (p) => (contacts[p[0]] ? [contacts[p[0]]] : [])],
    [/SELECT 1 FROM contacts WHERE id/, (p) => (contacts[p[0]] ? [{ "?column?": 1 }] : [])],
  ]);
  it("follows merged_into to the live survivor", async () => {
    expect(await resolveContactSurvivor(db, "walter1", "BF")).toMatchObject({ id: "walter3", merged: true, archived: false, missing: false });
    expect(await resolveContactSurvivor(db, "walter3", "BF")).toMatchObject({ id: "walter3", merged: false });
  });
  it("reports an archived record and a missing one, and stops on a circular merge", async () => {
    expect(await resolveContactSurvivor(db, "old", "BF")).toMatchObject({ id: "old", merged: false, archived: true });
    expect(await resolveContactSurvivor(db, "nope", "BF")).toMatchObject({ missing: true });
    const loop = await resolveContactSurvivor(db, "loopA", "BF");
    expect(loop.missing).toBe(false);
  });
});

describe("stage history", () => {
  it("drops the drafts' events once something was submitted and shows identical draft events once", () => {
    const draft = (app: string) => ({ application_id: app, from_stage: null, to_stage: "Received", trigger: "application_created", app_submitted: false });
    const seven = ["d1", "d2", "d3", "d4", "d5", "d6", "d7"].map(draft);
    expect(dedupeStageEvents(seven)).toHaveLength(1);
    const sub = { application_id: "s1", from_stage: null, to_stage: "Received", trigger: "application_created", app_submitted: true };
    const moved = { application_id: "s1", from_stage: "Received", to_stage: "In Review", trigger: "staff", app_submitted: true };
    const out = dedupeStageEvents([moved, ...seven, sub]);
    expect(out.map((e: any) => e.application_id)).toEqual(["s1", "s1"]);
    expect(out[0]).not.toHaveProperty("app_submitted");
  });
});

describe("people from an application become contacts", () => {
  it("creates the partner (Elizabeth Cullen) with the partner tag and links her to the application and company", async () => {
    const inserted: Row[] = [];
    const db = fakeDb([
      [/FROM applications a\s+LEFT JOIN contacts c ON c.id = a.contact_id/, () => [{
        id: "app-poke", silo: "BF", contact_id: "sean", company_id: "co-poke", owner_id: "u1",
        metadata: { applicant: { firstName: "Sean", lastName: "Dwyer", partnerFirstName: "Elizabeth", partnerLastName: "Cullen", partnerEmail: "PokeCullen@gmail.com", partnerPhone: "(310) 663-1364" } },
      }]],
      [/INSERT INTO contacts/, (p) => { inserted.push({ name: p[1], email: p[4], phone: p[5], role: p[8], tag: p[10] }); return [{ id: "eliz" }]; }],
      [/FROM application_form_responses/, () => []],
    ]);
    const out = await syncApplicationPeople(db, "app-poke");
    expect(out).toMatchObject({ created: 1 });
    expect(inserted).toEqual([{ name: "Elizabeth Cullen", email: "pokecullen@gmail.com", phone: "(310) 663-1364", role: "partner", tag: "partner" }]);
    const links = db.calls.filter((c) => /INSERT INTO application_contacts/.test(c.sql)).map((c) => c.params);
    expect(links).toEqual([["app-poke", "sean", "applicant"], ["app-poke", "eliz", "partner"]]);
    const people = db.calls.filter((c) => /INSERT INTO crm_company_people/.test(c.sql)).map((c) => c.params.slice(1, 4));
    expect(people).toEqual([["co-poke", "sean", "primary_applicant"], ["co-poke", "eliz", "partner"]]);
  });
  it("matches an existing contact by email before creating one", async () => {
    const db = fakeDb([
      [/FROM applications a\s+LEFT JOIN contacts c ON c.id = a.contact_id/, () => [{
        id: "app-1", silo: "SLF", contact_id: "c1", company_id: null, owner_id: null,
        metadata: { partner: { firstName: "Pat", lastName: "Partner", email: "pat@x.co" } },
      }]],
      [/lower\(btrim\(email\)\) = \$2/, (p) => (p[1] === "pat@x.co" && p[0] === "SLF" ? [{ id: "pat", company_id: null }] : [])],
    ]);
    const out = await syncApplicationPeople(db, "app-1");
    expect(out.created).toBe(0);
    expect(db.calls.some((c) => /INSERT INTO contacts/.test(c.sql))).toBe(false);
    expect(db.calls.some((c) => /UPDATE contacts/.test(c.sql) && c.params[0] === "pat" && c.params[1] === "partner")).toBe(true);
  });
  it("links each advisor to the client contact and the client's company with the advisor type", async () => {
    const db = fakeDb([
      [/FROM applications a\s+LEFT JOIN contacts c ON c.id = a.contact_id/, () => [{ id: "app-2", silo: "BF", contact_id: "client", company_id: "co-client", owner_id: null, metadata: {} }]],
      [/FROM application_form_responses/, () => [{ data: { advisors: { cpa: { firm: "Numbers LLP", contact: "Ann Count", email: "ann@numbers.ca" } } } }]],
      [/INSERT INTO companies/, () => [{ id: "co-firm" }]],
      [/INSERT INTO contacts/, () => [{ id: "ann" }]],
    ]);
    const out = await syncApplicationPeople(db, "app-2");
    expect(out.advisors).toBe(1);
    const created = db.calls.find((c) => /INSERT INTO contacts/.test(c.sql))!;
    expect(created.params[6]).toBe("co-firm"); // employed by their firm
    expect(created.params[10]).toBe("accountant");
    const link = db.calls.find((c) => /INSERT INTO crm_contact_links/.test(c.sql))!;
    expect(link.params).toEqual(["BF", "client", "ann", "Accountant (CPA)", "app-2"]);
    const assoc = db.calls.filter((c) => /INSERT INTO crm_company_people/.test(c.sql)).map((c) => c.params.slice(1, 5));
    expect(assoc).toContainEqual(["co-client", "ann", "accountant", "Accountant (CPA)"]);
  });
});
