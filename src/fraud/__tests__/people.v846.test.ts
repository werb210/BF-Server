// BF_SERVER_v846_FRAUD - checks 6 (business reality), 7 (phone / email), 8 (ID), 9 (device), 10 (behaviour) and the
// providers behind them, each against fake HTTP answers. No test reaches the network.
import { describe, expect, it } from "vitest";
import { addressSub, contactRisk, domainAgeSub, emailMatchesName, lineTypeSub, registrySub, sameName, businessReality } from "../checks/business.js";
import { corporationsCanadaProvider, parseCorporation, parseDirectors, registryNumber } from "../providers/registry.js";
import { classifyAddressByList, ipinfoProvider, parseIpinfo, rdapProvider, rdapRegistered, twilioLineTypeProvider, idvProvider, voiceProvider } from "../providers/lookups.js";
import { evaluateIdentity, normalizeDob } from "../checks/identity.js";
import { evaluateBehaviour, evaluateDevice, isSensitiveField, sameRegion, type DeviceRow } from "../checks/device.js";
import { isDisposableDomain } from "../checks/disposableDomains.js";
import { parseSignals } from "../deviceSignals.js";
import type { FetchLike } from "../providers/http.js";

const json = (body: unknown, status = 200): ReturnType<FetchLike> => Promise.resolve({ ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body) });

describe("registry provider (Corporations Canada)", () => {
  it("accepts a BN9 / 15-character BN or a corporation number", () => {
    expect(registryNumber("123456789 RC0001")).toEqual({ kind: "bn9", value: "123456789" });
    expect(registryNumber("123-456-789")).toEqual({ kind: "bn9", value: "123456789" });
    expect(registryNumber("1234567")).toEqual({ kind: "corp", value: "1234567" });
    expect(registryNumber("ABC")).toBeNull();
  });

  it("reads the v1 corporation and v2 directors bodies", async () => {
    const corp = [{ corporationId: 1234567, corporationNames: [{ CorporationName: { name: "ACME WIDGETS INC.", current: true } }], status: "Active", adresses: [{ address: { addressLine: ["1 Main St"], city: "Calgary", provinceCode: "AB", postalCode: "T2P 1A1" } }] }];
    expect(parseCorporation(corp)).toMatchObject({ name: "ACME WIDGETS INC.", status: "Active", active: true, corporationId: "1234567" });
    expect(parseDirectors({ _embedded: { directors: [{ firstName: "Jane", lastName: "Doe" }] } })).toEqual(["Jane Doe"]);
    const urls: Array<[string, Record<string, string> | undefined]> = [];
    const fake: FetchLike = (url, init) => { urls.push([url, init?.headers]); return json(url.includes("/directors") ? { _embedded: { directors: [{ firstName: "Jane", lastName: "Doe" }] } } : corp); };
    const p = corporationsCanadaProvider({ CORPORATIONS_CANADA_API_KEY: "k" } as any, fake);
    expect(p.configured()).toBe(true);
    const r = await p.lookup("123456789RC0001");
    expect(r).toMatchObject({ found: true, directors: ["Jane Doe"], active: true });
    expect(urls[0]![0]).toMatch(/\/corporations\/api\/v1\/corporations\/123456789\.json\?lang=eng$/);
    expect(urls[0]![1]).toMatchObject({ "user-key": "k" });
    expect(corporationsCanadaProvider({ NODE_ENV: "test" } as any).configured()).toBe(false);
    expect(await corporationsCanadaProvider({ CORPORATIONS_CANADA_API_KEY: "k" } as any, () => json({}, 404)).lookup("123456789")).toEqual({ found: false, reason: "not_found" });
  });
});

describe("check 6: business reality", () => {
  const rec = { found: true as const, name: "Acme Widgets Inc.", status: "Active", active: true, directors: ["Jane Q Doe", "Sam Roe"], address: null, corporationId: "1" };
  it("applicant listed as a director of an active corporation is green", () => {
    expect(registrySub(rec, ["Jane Doe"], "ACME WIDGETS").status).toBe("green");
  });
  it("dissolved is red; not a director or a different name is amber", () => {
    expect(registrySub({ ...rec, active: false, status: "Dissolved" }, ["Jane Doe"], null).status).toBe("red");
    const r = registrySub(rec, ["Bob Smith"], "Totally Different Ltd");
    expect(r.status).toBe("amber");
    expect(r.reasons.map((x) => x.code)).toEqual(["registry_name_differs", "not_a_director"]);
  });
  it("never passes a check it could not run", () => {
    expect(registrySub("not_configured", [], null).status).toBe("not_configured");
    expect(registrySub("no_number", [], null).status).toBe("not_applicable");
    expect(registrySub({ error: "timeout" }, [], null).status).toBe("error");
    expect(registrySub({ found: false, reason: "not_found" }, [], null).status).toBe("amber");
  });
  it("PO boxes, private mailboxes and virtual offices from the built-in list", () => {
    expect(classifyAddressByList("PO Box 123, Calgary AB").kind).toBe("po_box");
    expect(classifyAddressByList("123 Main St PMB 456, Edmonton").kind).toBe("mail_drop");
    expect(classifyAddressByList("The UPS Store, 10 King St").kind).toBe("mail_drop");
    expect(classifyAddressByList("Regus, 400 3 Ave SW, Calgary").kind).toBe("virtual_office");
    expect(classifyAddressByList("4500 Industrial Rd, Red Deer").kind).toBe("unknown");
    expect(addressSub(classifyAddressByList("PO Box 9"), true).status).toBe("amber");
    expect(addressSub(null, false).status).toBe("not_applicable");
  });
  it("a website registered last month is amber; combining keeps the worst result", async () => {
    const now = () => new Date("2026-10-01T00:00:00Z");
    const p = rdapProvider({} as any, () => json({ events: [{ eventAction: "registration", eventDate: "2026-09-01T00:00:00Z" }] }), now);
    const age = await p.age("acme.ca");
    expect(age).toEqual({ ok: true, registered: "2026-09-01T00:00:00.000Z", ageDays: 30 });
    const web = domainAgeSub("website", "acme.ca", age);
    expect(web.status).toBe("amber");
    expect(rdapRegistered({ events: [] })).toBeNull();
    const all = businessReality({ registry: registrySub("not_configured", [], null), address: addressSub(null, true), website: web, phone: lineTypeSub("business phone", null, null) });
    expect(all.status).toBe("amber");
    expect(rdapProvider({ FRAUD_RDAP: "off" } as any, () => json({})).configured()).toBe(false);
  });
});

describe("check 7: phone and email", () => {
  it("Twilio line type: VoIP is amber, mobile is green, no credentials is not configured", async () => {
    const lt = twilioLineTypeProvider({ TWILIO_ACCOUNT_SID: "AC1", TWILIO_AUTH_TOKEN: "t" } as any, () => json({ valid: true, line_type_intelligence: { type: "nonFixedVoip", carrier_name: "TextNow" } }));
    expect(lt.configured()).toBe(true);
    const voip = lineTypeSub("applicant's phone", "+15875550100", await lt.lookup("+15875550100"));
    expect(voip.status).toBe("amber");
    expect(voip.reasons[0]!.text).toMatch(/VoIP/);
    expect(lineTypeSub("applicant's phone", "+1", { ok: true, valid: true, type: "mobile", carrier: "Telus" }).status).toBe("green");
    expect(lineTypeSub("applicant's phone", "+1", "not_configured").status).toBe("not_configured");
    expect(twilioLineTypeProvider({ NODE_ENV: "test" } as any).configured()).toBe(false);
  });
  it("a disposable email is red; a name mismatch is only a note", () => {
    expect(isDisposableDomain("mailinator.com")).toBe(true);
    expect(isDisposableDomain("acme.ca", { FRAUD_EXTRA_DISPOSABLE_DOMAINS: "acme.ca" } as any)).toBe(true);
    const phone = lineTypeSub("applicant's phone", null, null);
    const r = contactRisk({ email: "x@mailinator.com", domain: "mailinator.com", emailDomainAge: domainAgeSub("email domain", "mailinator.com", "not_configured"), phone, nameMatch: false });
    expect(r.status).toBe("red");
    const ok = contactRisk({ email: "jane@gmail.com", domain: "gmail.com", emailDomainAge: domainAgeSub("email domain", "gmail.com", "not_configured"), phone, nameMatch: false });
    expect(ok.status).toBe("green");
  });
  it("matches names and email local parts sensibly", () => {
    expect(sameName("Jane Q. Doe", "JANE DOE")).toBe(true);
    expect(sameName("J Doe", "Jane Doe")).toBe(true);
    expect(sameName("Jane Doe", "John Smith")).toBe(false);
    expect(emailMatchesName("jdoe@acme.ca", "Jane", "Doe", null)).toBe(true);
    expect(emailMatchesName("info@acme.ca", "Jane", "Doe", null)).toBe(true);
    expect(emailMatchesName("acmewidgets@gmail.com", "Jane", "Doe", "Acme Widgets")).toBe(true);
    expect(emailMatchesName("xk9822@gmail.com", "Jane", "Doe", "Acme")).toBe(false);
  });
});

describe("check 8: ID", () => {
  const doc = { documentId: "d1", ocrName: "JANE DOE", ocrDob: "1980-04-21", fileType: "jpeg" as const, width: 4032, height: 3024, screenSized: false, hasCameraExif: true, editorSoftware: null };
  it("matching name and DOB is green, with the vendor part reported as not set up", () => {
    const r = evaluateIdentity({ idDocs: [doc], applicantName: "Jane Doe", applicantDob: "1980-04-21", ownerNames: [], reusedElsewhere: 0, idvConfigured: false });
    expect(r.status).toBe("green");
    expect(r.reasons.map((x) => x.code)).toEqual(["id_ok", "not_configured"]);
  });
  it("wrong name, wrong DOB, screenshot, reuse", () => {
    expect(evaluateIdentity({ idDocs: [{ ...doc, ocrName: "Bob Smith" }], applicantName: "Jane Doe", applicantDob: null, ownerNames: [], reusedElsewhere: 0, idvConfigured: true }).status).toBe("red");
    expect(evaluateIdentity({ idDocs: [{ ...doc, ocrDob: "21/04/1981" }], applicantName: "Jane Doe", applicantDob: "1980-04-21", ownerNames: [], reusedElsewhere: 0, idvConfigured: true }).reasons[0]!.code).toBe("id_dob_mismatch");
    const shot = evaluateIdentity({ idDocs: [{ ...doc, ocrName: null, width: 1170, height: 2532, screenSized: true, hasCameraExif: false }], applicantName: "Jane Doe", applicantDob: null, ownerNames: [], reusedElsewhere: 2, idvConfigured: true });
    expect(shot.reasons.map((x) => x.code)).toEqual(["id_screenshot", "id_reused"]);
    expect(evaluateIdentity({ idDocs: [], applicantName: null, applicantDob: null, ownerNames: [], reusedElsewhere: 0, idvConfigured: false }).status).toBe("not_applicable");
  });
  it("dates of birth: ISO, unambiguous day-first, ambiguous left alone", () => {
    expect(normalizeDob("1980-4-21")).toBe("1980-04-21");
    expect(normalizeDob("21/04/1980")).toBe("1980-04-21");
    expect(normalizeDob("04/05/1980")).toBeNull();
  });
  it("vendors that are not wired in say so and never return a verdict", async () => {
    expect(idvProvider({} as any).configured()).toBe(false);
    expect(await idvProvider({} as any).verify({ documentId: "x", image: Buffer.from(""), name: null, dob: null })).toEqual({ ok: false, error: "not_configured" });
    expect(await voiceProvider({} as any).analyze({ recordingId: "RE1", url: "u" })).toEqual({ ok: false, error: "not_configured" });
  });
});

describe("checks 9 and 10: device, location, behaviour", () => {
  const row: DeviceRow = { device_hash: "d", ip_hash: "i", ip_country: "CA", ip_region: "Alberta", asn: "AS1", asn_org: "Telus", ip_flags: { vpn: false, hosting: false }, ip_provider: "ipinfo", behaviour: { completion_seconds: 600, fields_completed: 40, pasted_fields: [] }, answers_hash: "a" };
  it("a normal device is green; many businesses on one device is red; VPN and other countries are amber", () => {
    expect(evaluateDevice({ row, otherBusinessesSameDevice: 0, otherBusinessesSameIp: 0, licenseeCountry: "CA", businessProvince: "AB", ipConfigured: true }).status).toBe("green");
    expect(evaluateDevice({ row, otherBusinessesSameDevice: 3, otherBusinessesSameIp: 0, licenseeCountry: "CA", businessProvince: "AB", ipConfigured: true }).status).toBe("red");
    const vpn = evaluateDevice({ row: { ...row, ip_flags: { vpn: true }, ip_country: "RO" }, otherBusinessesSameDevice: 0, otherBusinessesSameIp: 0, licenseeCountry: "CA", businessProvince: "AB", ipConfigured: true });
    expect(vpn.reasons.map((x) => x.code)).toEqual(["ip_vpn", "ip_out_of_country"]);
    expect(evaluateDevice({ row: null, otherBusinessesSameDevice: 0, otherBusinessesSameIp: 0, licenseeCountry: "CA", businessProvince: null, ipConfigured: false }).status).toBe("not_applicable");
    expect(evaluateDevice({ row, otherBusinessesSameDevice: 0, otherBusinessesSameIp: 0, licenseeCountry: "CA", businessProvince: "AB", ipConfigured: false }).reasons.some((r) => r.code === "not_configured")).toBe(true);
    expect(sameRegion("AB", "Alberta")).toBe(true);
    expect(sameRegion("Ontario", "AB")).toBe(false);
  });
  it("impossibly fast, pasted sensitive details and identical answers", () => {
    const fast = evaluateBehaviour({ row: { ...row, behaviour: { completion_seconds: 30, fields_completed: 40, pasted_fields: ["sin", "account_number", "transit", "email"] } }, sameAnswersOtherBusinesses: 1 });
    expect(fast.status).toBe("red");
    expect(fast.reasons.map((x) => x.code)).toEqual(["paste_sensitive", "too_fast", "same_answers"]);
    expect(evaluateBehaviour({ row, sameAnswersOtherBusinesses: 0 }).status).toBe("green");
  });
  it("sensitive field names are matched on whole tokens", () => {
    expect(isSensitiveField("accountNumber")).toBe(true);
    expect(isSensitiveField("applicant.sin")).toBe(true);
    expect(isSensitiveField("business_number")).toBe(true);
    expect(isSensitiveField("business_name")).toBe(false);
    expect(isSensitiveField("purposeOfFunds")).toBe(false);
  });

  it("the beacon accepts counts and field NAMES only", () => {
    const s = parseSignals({ application_id: "11111111-2222-4333-8444-555555555555", device_id: "abcd1234-ef", platform: "ios", answers_fingerprint: "a".repeat(64), behaviour: { completion_seconds: "120", fields_completed: 30, pasted_fields: ["sin", "account number <script>", 5], autofill_used: true, typed_value: "secret" } })!;
    expect(s.behaviour).toEqual({ completion_seconds: 120, fields_completed: 30, pasted_fields: ["sin", "accountnumberscript"], autofill_used: true, steps: null });
    expect(JSON.stringify(s)).not.toContain("secret");
    expect(parseSignals({ application_id: "x" })).toBeNull();
    expect(parseSignals({ application_id: "11111111-2222-4333-8444-555555555555", answers_fingerprint: "nothex" })!.answers_fingerprint).toBeNull();
  });
  it("ipinfo: privacy flags when present, hosting networks otherwise", async () => {
    expect(parseIpinfo({ country: "CA", region: "Alberta", org: "AS852 TELUS Communications Inc.", privacy: { vpn: true, proxy: false, tor: false, hosting: false } }))
      .toMatchObject({ country: "CA", asn: "AS852", asnOrg: "TELUS Communications Inc.", vpn: true });
    expect(parseIpinfo({ country: "US", org: "AS16509 Amazon.com, Inc." }).hosting).toBe(true);
    expect(parseIpinfo({ country: "CA", org: "AS852 TELUS" }).hosting).toBeNull();
    const p = ipinfoProvider({ IPINFO_TOKEN: "t" } as any, () => json({ country: "CA", org: "AS1 X" }));
    expect((await p.lookup("203.0.113.9")).ok).toBe(true);
    expect(ipinfoProvider({ NODE_ENV: "test" } as any).configured()).toBe(false);
  });
});
