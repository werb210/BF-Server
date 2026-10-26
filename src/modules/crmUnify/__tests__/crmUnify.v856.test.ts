// BF_SERVER_v856_CRM_UNIFY - the pure rules behind the shared CRM: tags, clean-up text rules, the SSRF guard,
// duplicate matching, company people and company details. No database.
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isSystemTag, labelForTag, normalizeTag, normalizeTags, parseTagFilter, tagFromLabel, tagKind, untaggedSql } from "../tags.js";
import {
  formatPhoneDisplay, isAllCapsOrLower, properCaseCompanyName, properCasePersonName, proposeCompanyFixes, proposeContactFixes, toE164,
} from "../textClean.js";
import { checkUrl, isBlockedAddress, safeFetchText, websiteFor, type LookupFn } from "../webSource.js";
import { companyNamesSimilar, companyReasons, normCompanyName, pickFieldChoices } from "../duplicates.js";
import { advisorPeople, applicationPeople, groupFor, personKey } from "../people.js";
import { buildCompanyDetails, detailUpdates } from "../companyDetails.js";
import { applicantNameFrom, validChange } from "../cleanup.js";

describe("tags", () => {
  it("normalises case, spaces, punctuation and known synonyms", () => {
    expect(normalizeTag("Contact form")).toBe("contact_form");
    expect(normalizeTag("  LENDER ")).toBe("lender");
    expect(normalizeTag("Account/Book Keeper")).toBe("accountant");
    expect(normalizeTag("Accountant/advisor")).toBe("accountant");
    expect(normalizeTag("booked-call")).toBe("booked_call");
    expect(normalizeTags(["Lender", "lender", " LENDER", "Contact form", "contact_form", "", null])).toEqual(["contact_form", "lender"]);
  });
  it("classifies core, system, custom and other tags", () => {
    expect(tagKind("Active")).toBe("core");
    expect(tagKind("application_started")).toBe("system");
    expect(tagKind("Contact form")).toBe("system");
    expect(tagKind("vip", new Set(["vip"]))).toBe("custom");
    expect(tagKind("old free text")).toBe("other");
    expect(isSystemTag("Booked call")).toBe(true);
    expect(labelForTag("accountant")).toBe("Accountant/Bookkeeper");
    expect(tagFromLabel("  Insurance   agent ")).toEqual({ slug: "insurance_agent", label: "Insurance agent" });
    expect(tagFromLabel("   ")).toBeNull();
  });
  it("parses the list filter (any of, untagged) and builds the untagged SQL", () => {
    expect(parseTagFilter({ tags: "Lender,__none__" })).toEqual({ tags: ["lender"], untagged: true });
    expect(parseTagFilter({ tag: "active" })).toEqual({ tags: ["active"], untagged: false });
    expect(untaggedSql("c.tags", 4)).toContain("$4::text[]");
  });
});

describe("clean-up text rules", () => {
  it("proper-cases people, keeping Mc / Mac / O' / hyphens and particles", () => {
    expect(properCasePersonName("JOHN O'BRIEN-MCDONALD")).toBe("John O'Brien-McDonald");
    expect(properCasePersonName("mary macdonald")).toBe("Mary MacDonald");
    expect(properCasePersonName("ALAN MACK")).toBe("Alan Mack");
    expect(properCasePersonName("anna van der berg")).toBe("Anna van der Berg");
    expect(isAllCapsOrLower("John Smith")).toBe(false);
  });
  it("proper-cases companies and writes LLC, Inc., Ltd.", () => {
    expect(properCaseCompanyName("POKE PROD LLC")).toBe("Poke Prod LLC");
    expect(properCaseCompanyName("acme widgets inc")).toBe("Acme Widgets Inc.");
    expect(properCaseCompanyName("NORTHERN GATEWAY FILMS LTD")).toBe("Northern Gateway Films Ltd.");
    expect(properCaseCompanyName("BIBUSA CN LLC")).toBe("Bibusa CN LLC");
    expect(properCaseCompanyName("parish construction and roofing")).toBe("Parish Construction and Roofing");
  });
  it("stores phones as E.164 and shows them as (403) 555-0123", () => {
    expect(toE164("(403) 555-0123")).toBe("+14035550123");
    expect(toE164("1-403-555-0123")).toBe("+14035550123");
    expect(toE164("+44 20 7946 0958")).toBe("+442079460958");
    expect(toE164("555-0123")).toBeNull();
    expect(formatPhoneDisplay("+14035550123")).toBe("(403) 555-0123");
  });
  it("proposes contact fixes, and the real name for an application-started placeholder", () => {
    const fixes = proposeContactFixes({ name: "Unknown (application started)", email: " Sean.Dwyer@Gmail.com", phone: "323-898-2498" }, { first: "sean", last: "dwyer" });
    expect(fixes).toEqual(expect.arrayContaining([
      expect.objectContaining({ field: "name", after: "Sean Dwyer" }),
      expect.objectContaining({ field: "email", after: "sean.dwyer@gmail.com" }),
      expect.objectContaining({ field: "phone", after: "+13238982498" }),
    ]));
    expect(proposeContactFixes({ name: "Sean Dwyer", email: "sean@x.com", phone: "+13238982498" })).toEqual([]);
    expect(proposeContactFixes({ first_name: "JOHN", last_name: "smith  " })).toEqual([
      expect.objectContaining({ field: "first_name", after: "John", reason: "All capitals" }),
      expect.objectContaining({ field: "last_name", after: "Smith" }),
    ]);
  });
  it("proposes company fixes", () => {
    expect(proposeCompanyFixes({ name: "POKE PROD LLC", phone: "4035550123" })).toEqual([
      expect.objectContaining({ field: "name", after: "Poke Prod LLC" }),
      expect.objectContaining({ field: "phone", after: "+14035550123" }),
    ]);
  });
  it("only accepts whitelisted fields in a change, and finds the applicant's real name", () => {
    expect(validChange({ entity: "contact", entityId: "11111111-1111-4111-8111-111111111111", field: "email", before: "A@x.com", after: "a@x.com" })).toBe(true);
    expect(validChange({ entity: "contact", entityId: "11111111-1111-4111-8111-111111111111", field: "role", before: "a", after: "b" })).toBe(false);
    expect(validChange({ entity: "company", entityId: "nope", field: "name", before: "a", after: "b" })).toBe(false);
    expect(applicantNameFrom({ applicant: { firstName: "Sean", lastName: "Dwyer" } })).toEqual({ first: "Sean", last: "Dwyer" });
    expect(applicantNameFrom({ formData: { applicant: { fullName: "Elizabeth Cullen" } } })).toEqual({ first: "Elizabeth", last: "Cullen" });
  });
});

describe("SSRF guard", () => {
  it("blocks private, loopback, link-local and reserved addresses (v4 and v6)", () => {
    for (const ip of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "224.0.0.1",
      "::1", "::", "fe80::1", "fc00::1", "fd12:3456::1", "::ffff:127.0.0.1", "::ffff:10.0.0.1", "64:ff9b::a00:1", "ff02::1", "2001:db8::1"]) {
      expect(isBlockedAddress(ip), ip).toBe(true);
    }
    for (const ip of ["8.8.8.8", "142.250.72.14", "2607:f8b0:4005:80a::200e", "::ffff:8.8.8.8"]) expect(isBlockedAddress(ip), ip).toBe(false);
  });
  it("allows only http/https on 80/443 to DNS names", () => {
    expect(checkUrl("file:///etc/passwd", [80, 443])).toMatchObject({ ok: false, error: "scheme_not_allowed" });
    expect(checkUrl("http://127.0.0.1/", [80, 443])).toMatchObject({ ok: false, error: "ip_literal_not_allowed" });
    expect(checkUrl("http://[::1]/", [80, 443])).toMatchObject({ ok: false, error: "ip_literal_not_allowed" });
    expect(checkUrl("http://localhost/", [80, 443])).toMatchObject({ ok: false, error: "host_not_allowed" });
    expect(checkUrl("http://metadata.internal/", [80, 443])).toMatchObject({ ok: false, error: "host_not_allowed" });
    expect(checkUrl("https://acme.com:8443/", [80, 443])).toMatchObject({ ok: false, error: "port_not_allowed" });
    expect(checkUrl("https://user:pw@acme.com/", [80, 443])).toMatchObject({ ok: false, error: "credentials_not_allowed" });
    expect(checkUrl("https://acme.com/about", [80, 443]).ok).toBe(true);
  });
  it("uses the website field, else a work email domain, and skips free mail providers", () => {
    expect(websiteFor("www.allencapfunding.com", [])).toMatchObject({ host: "allencapfunding.com", from: "website" });
    expect(websiteFor("", ["pokedwyer@gmail.com", "x@shaw.ca", "Tony@AllenCapFunding.com"])).toMatchObject({ host: "allencapfunding.com", from: "email" });
    expect(websiteFor(null, ["a@outlook.com", "b@hotmail.com", "c@yahoo.ca", "d@icloud.com", "e@live.com", "f@aol.com", "g@proton.me", "h@telus.net"])).toBeNull();
  });

  describe("fetching (local test server, DNS faked)", () => {
    let server: http.Server;
    let port = 0;
    beforeAll(async () => {
      server = http.createServer((req, res) => {
        if (req.url === "/to-private") { res.writeHead(302, { location: `http://evil.test:${port}/` }); return res.end(); }
        if (req.url === "/loop") { res.writeHead(302, { location: "/loop" }); return res.end(); }
        if (req.url === "/big") { res.writeHead(200, { "content-type": "text/html" }); res.end("<p>" + "x".repeat(5000) + "</p>"); return; }
        if (req.url === "/pdf") { res.writeHead(200, { "content-type": "application/pdf" }); return res.end("%PDF"); }
        if (req.url === "/slow") { setTimeout(() => { res.writeHead(200, { "content-type": "text/html" }); res.end("late"); }, 1500); return; }
        res.writeHead(200, { "content-type": "text/html" });
        res.end("<html><head><title>Acme</title></head><body><script>x()</script><h1>We build decks</h1></body></html>");
      });
      await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
      port = (server.address() as AddressInfo).port;
    });
    afterAll(() => new Promise<void>((r) => server.close(() => r())));
    // site.test resolves to the test server; evil.test resolves to a private address.
    const lookup: LookupFn = (host, _o, cb) => cb(null, host === "site.test" ? [{ address: "127.0.0.1", family: 4 }] : [{ address: "10.0.0.7", family: 4 }]);
    const opts = () => ({ lookup, ports: [port], isAllowedAddress: (ip: string) => ip === "127.0.0.1" });

    it("reads an allowed page", async () => {
      const r = await safeFetchText(`http://site.test:${port}/`, opts());
      expect(r).toMatchObject({ ok: true, status: 200 });
      if (r.ok) expect(r.body).toContain("We build decks");
    });
    it("refuses a host that resolves to a private address", async () => {
      expect(await safeFetchText(`http://evil.test:${port}/`, opts())).toMatchObject({ ok: false, error: "blocked_address" });
    });
    it("checks every redirect hop", async () => {
      expect(await safeFetchText(`http://site.test:${port}/to-private`, opts())).toMatchObject({ ok: false, error: "blocked_address" });
      expect(await safeFetchText(`http://site.test:${port}/loop`, opts())).toMatchObject({ ok: false, error: "too_many_redirects" });
    });
    it("caps size and time, and reads text only", async () => {
      const big = await safeFetchText(`http://site.test:${port}/big`, { ...opts(), maxBytes: 1000 });
      expect(big.ok && big.body.length).toBe(1000);
      expect(await safeFetchText(`http://site.test:${port}/pdf`, opts())).toMatchObject({ ok: false, error: "not_text" });
      expect(await safeFetchText(`http://site.test:${port}/slow`, { ...opts(), timeoutMs: 300 })).toMatchObject({ ok: false, error: "timeout" });
    });
  });
});

describe("duplicates", () => {
  it("compares company names without suffixes and punctuation", () => {
    expect(normCompanyName("Poke Prod, LLC")).toBe("poke prod");
    expect(companyNamesSimilar("Northern Gateway Films", "Northern Gateway Films Inc.")).toBe(true);
    expect(companyNamesSimilar("Accord Finacial", "Accord Financial")).toBe(false);
    expect(companyNamesSimilar("Big Brokerage", "Big Broker")).toBe(true); // a shortened last word is the same company
    expect(companyReasons({ name: "Acme LLC", website: "https://www.acme.com", phone: "403-555-0123" }, { name: "ACME", website: "acme.com/about", phone: "+14035550123" }))
      .toEqual(["Same name", "Same website", "Same phone"]);
  });
  it("only accepts merge choices that are really on one of the records", () => {
    const rows = [{ email: "a@x.com", phone: "1" }, { email: "b@x.com", phone: "2" }];
    expect(pickFieldChoices([{ key: "email" }, { key: "phone" }], rows, { email: "b@x.com", phone: "999", role: "x" })).toEqual([["email", "b@x.com"]]);
  });
});

describe("company people", () => {
  it("finds partners and guarantors the applicant typed (nested, flat and lists)", () => {
    const people = applicationPeople({
      applicant: { firstName: "Sean", lastName: "Dwyer", partnerFirstName: "Elizabeth", partnerLastName: "Cullen", partnerEmail: "PokeCullen@gmail.com", partnerPhone: "(310) 663-1364" },
      guarantors: [{ name: "Gary Guarantor", email: "g@x.com" }],
    });
    expect(people).toEqual([
      expect.objectContaining({ role: "partner", name: "Elizabeth Cullen", email: "pokecullen@gmail.com", phone: "(310) 663-1364" }),
      expect.objectContaining({ role: "guarantor", name: "Gary Guarantor" }),
    ]);
  });
  it("reads the Professional Advisors form", () => {
    const adv = advisorPeople({ advisors: { cpa: { firm: "Numbers LLP", contact: "Ann Count", email: "ann@numbers.ca", phone: "403" }, attorney: { firm: "Law Co" }, insurance: {} } });
    expect(adv).toEqual([
      expect.objectContaining({ role: "accountant", name: "Ann Count", detail: "Numbers LLP" }),
      expect.objectContaining({ role: "lawyer", name: "Law Co" }),
    ]);
    expect(groupFor("bookkeeper")).toBe("advisors");
    expect(personKey({ email: "A@x.com" })).toBe("email:a@x.com");
  });
});

describe("company details", () => {
  it("falls back to the application's business section and marks where each value came from", () => {
    const fields = buildCompanyDetails(
      { name: "Poke Prod LLC", city: "Los Angeles", owner_id: null, created_at: "2026-10-21T00:00:00Z" },
      { metadata: { business: { legalName: "Poke Prod LLC", address: "341 N Orange Dr", state: "CA", postalCode: "90036", phone: "+13106631364", businessStructure: "S Corporation", startDate: "2012-02-08", website: "pokeprod.com" } } },
      { name: null },
    );
    const f = (k: string) => fields.find((x) => x.key === k)!;
    expect(f("city")).toMatchObject({ value: "Los Angeles", source: "company" });
    expect(f("address")).toMatchObject({ value: "341 N Orange Dr", source: "application" });
    expect(f("province")).toMatchObject({ value: "CA", source: "application" });
    expect(f("entity_type")).toMatchObject({ value: "S Corporation" });
    expect(f("domain")).toMatchObject({ value: "pokeprod.com" });
    expect(f("created_at").editable).toBe(false);
  });
  it("validates edits and keeps the duplicate columns in step", () => {
    expect(detailUpdates({ city: " Calgary ", employees: "12", annual_revenue: "$1,200,000", bogus: 1 })).toEqual({
      ok: true, sets: [["address_city", "Calgary"], ["city", "Calgary"], ["employee_count", 12], ["number_of_employees", 12], ["estimated_annual_revenue", 1200000], ["annual_revenue", 1200000]],
    });
    expect(detailUpdates({ start_date: "Feb 2012" })).toMatchObject({ ok: false, field: "start_date" });
    expect(detailUpdates({ name: "" })).toMatchObject({ ok: false, field: "name" });
  });
});
