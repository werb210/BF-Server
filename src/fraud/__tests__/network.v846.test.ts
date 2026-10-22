// BF_SERVER_v846_FRAUD - checks 12 (network), 13 (watchlist), 14 (inside-job), 15 (voice), 16 (score and pre-screen),
// the profile reader, the hashing rules, and Boreal running all 15 checks (no check 3).
import { afterEach, describe, expect, it } from "vitest";
import { evaluateInsider, evaluateNetwork, evaluateVoice, type Network } from "../checks/misc.js";
import { classifyRequest, handleCandidates, noteFileOpened, _resetInsiderCounters, alertAdmins, bodyKeys } from "../insider.js";
import { applicationRef, checkWatchlist, evaluateWatchlist, watchlistEntries, watchlistReady } from "../watchlist.js";
import { band, computeScore, prescreenText, type StoredResult } from "../score.js";
import { renderPrescreenPdf } from "../prescreen.js";
import { buildProfile, parseMoneyRange } from "../profile.js";
import { localHash, normAddress, normEmail, normPhone, watchlistHash, normDomain } from "../hash.js";
import { allowedChecks } from "../store.js";
import { answerBySql } from "../../__tests__/helpers/answerBySql.js";
import { FRAUD_CHECKS } from "../catalogue.js";
import { maskEmail, maskPhone, sameSiloNetwork, streetKey } from "../network.js";

/** A fake database that answers by SQL content and records every statement. */
function fakeDb(answer: (sql: string, params: unknown[]) => any[] = () => []) {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  return { calls, query: async (sql: string, params: unknown[] = []) => { calls.push({ sql, params }); return { rows: answer(sql, params) }; } };
}

describe("check 12: network", () => {
  const net: Network = {
    nodes: [
      { id: "app:me", type: "application", label: "Me", current: true },
      { id: "id:phone:1", type: "phone", label: "Phone ...0100" },
      { id: "id:bank:2", type: "bank_account", label: "Account ...9876" },
      { id: "app:f", type: "application", label: "Fraudco", fraud: true },
      { id: "app:x", type: "application", label: "Other" },
    ],
    edges: [{ from: "app:me", to: "id:phone:1" }, { from: "app:me", to: "id:bank:2" }, { from: "id:phone:1", to: "app:f" }, { from: "id:bank:2", to: "app:f" }, { from: "id:phone:1", to: "app:x" }],
  };
  it("a link to confirmed fraud is red and says what was shared", () => {
    const r = evaluateNetwork(net, "me");
    expect(r.status).toBe("red");
    expect(r.reasons[0]!.text).toMatch(/phone number, bank account/);
    expect(r.details).toMatchObject({ linked_applications: 2, linked_fraud: 1 });
  });
  it("the network view keeps only applications in the file's silo (and drops identifiers left with no link)", async () => {
    const out = await sameSiloNetwork({ query: answerBySql([["FROM applications", { rows: [{ id: "f" }] }]]) }, net, "BF");
    expect(out.nodes.map((n) => n.id).sort()).toEqual(["app:f", "app:me", "id:bank:2", "id:phone:1"]);
    expect(out.edges.some((e) => e.to === "app:x")).toBe(false);
    const onlyX = await sameSiloNetwork({ query: answerBySql([["FROM applications", { rows: [{ id: "x" }] }]]) }, net, "BF");
    expect(onlyX.nodes.map((n) => n.id).sort()).toEqual(["app:me", "app:x", "id:phone:1"]);
  });

  it("no links is green; masking keeps only the last digits", () => {
    expect(evaluateNetwork({ nodes: [net.nodes[0]!], edges: [] }, "me").status).toBe("green");
    expect(maskPhone("5875550100")).toBe("Phone ...0100");
    expect(maskEmail("jane@acme.ca")).toBe("Email j***@acme.ca");
    expect(streetKey("4500 Industrial Rd, Red Deer")).toBe("4500industrialrd");
    expect(streetKey("PO Box")).toBeNull();
  });
});

describe("check 14: inside-job alerts", () => {
  afterEach(() => _resetInsiderCounters());
  const at = new Date("2026-10-23T05:30:00Z"); // 23:30 in Edmonton the night before

  it("classifies banking-detail edits, approvals, exports and night work - by key names only", () => {
    const c = classifyRequest({ method: "PATCH", path: "/applications/abc", body: { metadata: { bank: { transit_number: "12345", account_number: "999" } }, stage: "Accepted" }, at, timeZone: "America/Edmonton" });
    expect(c.map((x) => x.kind)).toEqual(["banking_details_changed", "approved_own_file", "off_hours_write"]);
    expect(JSON.stringify(c)).not.toContain("999");
    expect(classifyRequest({ method: "GET", path: "/export", body: {}, at, timeZone: "UTC" })[0]!.kind).toBe("bulk_export");
    expect(classifyRequest({ method: "GET", path: "/reports/pipeline/export.csv", body: {}, at, timeZone: "UTC" })[0]!.kind).toBe("export");
    expect(classifyRequest({ method: "GET", path: "/applications/abc", body: {}, at: new Date("2026-10-23T18:00:00Z"), timeZone: "America/Edmonton" })).toEqual([]);
    expect(bodyKeys({ a: { b: { c: 1 } } })).toEqual(["a", "b", "c"]);
  });

  it("opening more files in an hour than the limit fires once", () => {
    const now = new Date("2026-10-23T15:00:00Z");
    let fired = 0;
    for (let i = 0; i < 10; i++) if (noteFileOpened("u1", `app${i}`, now, 5)) fired++;
    expect(fired).toBe(1);
  });

  it("approving a file is only an event when the approver owns it", async () => {
    const db = fakeDb((sql) => (sql.includes("FROM applications") ? [{ owner: "u1", pipeline_state: "Accepted" }] : sql.includes("RETURNING id") ? [{ id: 1 }] : []));
    const n = await handleCandidates(db as any, { id: "u1", label: "Pat" }, [{ kind: "approved_own_file", severity: "amber", applicationId: "a1", detail: {}, needsOwnerCheck: true }], new Date());
    expect(n).toBe(1);
    const other = fakeDb((sql) => (sql.includes("FROM applications") ? [{ owner: "someone-else", pipeline_state: "Accepted" }] : []));
    expect(await handleCandidates(other as any, { id: "u1", label: "Pat" }, [{ kind: "approved_own_file", severity: "amber", applicationId: "a1", detail: {}, needsOwnerCheck: true }], new Date())).toBe(0);
  });

  it("five exports in an hour become one bulk-export event", async () => {
    const db = fakeDb((sql) => (sql.includes("COUNT(*)") ? [{ n: 5 }] : sql.includes("RETURNING id") ? [{ id: 9 }] : []));
    expect(await handleCandidates(db as any, { id: "u2", label: "Lee" }, [{ kind: "export", severity: "info", applicationId: null, detail: {} }], new Date())).toBe(1);
    expect(db.calls.some((c) => c.params.includes("bulk_export"))).toBe(true);
  });

  it("alerts every other Admin and marks the event alerted", async () => {
    const db = fakeDb((sql) => (sql.includes("FROM staff_risk_events") ? [{ id: 7, user_id: "u1", kind: "banking_details_changed", application_id: "a1", detail: { by: "Pat" } }] : sql.includes("FROM users") ? [{ id: "u1" }, { id: "admin2" }] : []));
    expect(await alertAdmins(db as any)).toBe(1);
    const inserts = db.calls.filter((c) => c.sql.includes("INSERT INTO notifications"));
    expect(inserts).toHaveLength(1);
    expect(inserts[0]!.params[1]).toBe("admin2");
    expect(String(inserts[0]!.params[3])).toMatch(/Pat changed the banking details/);
    expect(db.calls.some((c) => c.sql.includes("SET alerted_at = now()"))).toBe(true);
  });

  it("evaluates events on a file", () => {
    expect(evaluateInsider([]).status).toBe("green");
    expect(evaluateInsider([{ kind: "banking_details_changed", severity: "red", created_at: "2026-10-23T05:30:00.000Z", user_label: "Pat" }]).reasons[0]!.text).toMatch(/^Pat changed the banking details/);
  });
});

describe("check 15: voice", () => {
  it("with no vendor it reports the recordings as not checked - never a verdict", () => {
    const r = evaluateVoice([{ recordingId: "RE1", status: "not_configured" }], false);
    expect(r.status).toBe("not_configured");
    expect(r.reasons[0]!.text).toMatch(/1 recorded call/);
    expect(evaluateVoice([], false).status).toBe("not_applicable");
    expect(evaluateVoice([{ recordingId: "RE1", status: "likely_synthetic", probability: 0.9 }], true).status).toBe("red");
  });
});

describe("check 13: shared watchlist", () => {
  const env = { KS_WATCHLIST_PEPPER: "network-pepper-0123456789", KS_OPS_URL: "https://ops.example", KS_LICENSEE_ID: "11111111-1111-4111-8111-111111111111", KS_OPS_KEY: "k" } as any;
  const profile = buildProfile({ app: { id: "a1", metadata: { applicant: { firstName: "Jane", lastName: "Doe", email: "Jane.Doe+loans@Gmail.com", phone: "(587) 555-0100", dob: "1980-04-21" }, business: { businessName: "Acme", businessNumber: "123456789RC0001", address: "1 Main St", city: "Calgary" } } } });

  it("two brokerages hash the same phone the same way; nothing raw is sent; no pepper = nothing", () => {
    const a = watchlistEntries(profile, { bankAccounts: ["00123-456-7890"] }, env);
    const kinds = a.map((e) => e.kind).sort();
    expect(kinds).toEqual(["address", "bank_account", "business_number", "email", "person", "phone"]);
    expect(a.find((e) => e.kind === "phone")!.hash).toBe(watchlistHash("phone", "5875550100", { KS_WATCHLIST_PEPPER: "network-pepper-0123456789" } as any));
    expect(JSON.stringify(a)).not.toMatch(/5875550100|jane|Doe|123456789/i);
    expect(watchlistEntries(profile, {}, { KS_WATCHLIST_PEPPER: "short" } as any)).toEqual([]);
    expect(applicationRef("a1", { JWT_SECRET: "s" } as any)).not.toContain("a1");
  });

  it("checks with operations and turns matches into red reasons", async () => {
    const entries = watchlistEntries(profile, {}, env);
    const phone = entries.find((e) => e.kind === "phone")!;
    let sent: any = null;
    const fetchImpl: any = async (url: string, init: any) => { sent = { url, body: JSON.parse(init.body), key: init.headers["X-KS-Ops-Key"] }; return { ok: true, status: 200, json: async () => ({ matches: [{ hash: phone.hash, brokerages: 2, reports: 3 }, { hash: "not-ours" }] }), text: async () => "" }; };
    const r = await checkWatchlist(entries, { env, fetchImpl });
    expect(sent.url).toBe("https://ops.example/api/licensees/11111111-1111-4111-8111-111111111111/watchlist/check");
    expect(sent.key).toBe("k");
    expect(r).toEqual({ ok: true, matches: [{ kind: "phone", hash: phone.hash, brokerages: 2, reports: 3 }] });
    const ev = evaluateWatchlist({ optIn: true, ready: { ok: true }, check: r, entries: entries.length });
    expect(ev.status).toBe("red");
    expect(ev.reasons[0]!.text).toBe("The phone number matches confirmed fraud reported by 2 other brokerages.");
  });

  it("off, not set up, unreachable: never a false all-clear", () => {
    expect(evaluateWatchlist({ optIn: false, ready: { ok: true }, check: null, entries: 3 }).status).toBe("not_applicable");
    expect(evaluateWatchlist({ optIn: true, ready: watchlistReady({} as any), check: null, entries: 3 }).status).toBe("not_configured");
    expect(evaluateWatchlist({ optIn: true, ready: { ok: true }, check: { ok: false, error: "x" }, entries: 3 }).status).toBe("error");
  });
});

describe("check 16: score and pre-screen", () => {
  const all = new Set(FRAUD_CHECKS.map((c) => c.key));
  const row = (check_key: string, status: StoredResult["status"], text = "x", subject = ""): StoredResult => ({ check_key, subject, status, reasons: [{ code: "c", severity: status === "red" ? "red" : status === "amber" ? "amber" : "info", text }] });

  it("adds the weights of red and amber checks, extra red documents count a little, capped at 100", () => {
    const s = computeScore([row("fraud_1", "red", "edited", "d1"), row("fraud_1", "red", "edited", "d2"), row("fraud_5", "amber", "revenue high"), row("fraud_7", "green")], all);
    expect(s.score).toBe(30 + 5 + 10);
    expect(s.band).toBe("medium");
    expect(s.reasons[0]!.severity).toBe("red");
    expect(s.covered.map((c) => c.check)).toEqual(["fraud_1", "fraud_5", "fraud_7"]);
    expect(s.not_covered.some((c) => c.check === "fraud_2")).toBe(true);
    expect(all.has("fraud_3" as any)).toBe(false); // no live-bank check (no Flinks)
    const many = computeScore(["fraud_1", "fraud_2", "fraud_4", "fraud_6"].map((k) => row(k, "red")), all);
    expect(many.score).toBe(100);
    expect(band(19)).toBe("low");
    expect(band(50)).toBe("high");
  });

  it("only counts the checks it is given", () => {
    const starter = new Set(["fraud_1", "fraud_2", "fraud_4", "fraud_5"]);
    const s = computeScore([row("fraud_7", "red"), row("fraud_1", "green")], starter);
    expect(s.score).toBe(0);
    expect(s.not_covered.map((c) => c.check)).toEqual(["fraud_2", "fraud_4", "fraud_5"]);
  });

  it("the pre-screen text is honest about what was not covered, and renders as a PDF", async () => {
    const s = computeScore([row("fraud_1", "green"), { check_key: "fraud_6", subject: "", status: "not_configured", reasons: [{ code: "not_configured", severity: "info", text: "The corporate registry lookup is not set up." }] }], all);
    const lines = prescreenText(s, { company: "Northwind Capital", applicationName: "Acme", at: new Date("2026-10-23T12:00:00Z") });
    expect(lines).toContain("Fraud score: 0 / 100 (low risk)");
    expect(lines).toContain("  - Business reality check: The corporate registry lookup is not set up.");
    expect(lines.at(-1)).toMatch(/not a finding of fraud/);
    const pdf = await renderPrescreenPdf(lines);
    expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
  });
});

describe("profile, hashing, all checks on", () => {
  it("reads the applicant and business from metadata, then contact and company rows", () => {
    const p = buildProfile({ app: { id: "a", metadata: { kyc: { annualRevenue: "$500k-$1M" }, applicant: { firstName: "Jane", lastName: "Doe" } } }, contact: { email: "j@acme.ca", phone: "5875550100", dob: "1980-04-21" }, company: { legal_name: "Acme Inc", website: "https://www.acme.ca/about", phone: "4035550100" } });
    expect(p.applicant).toMatchObject({ name: "Jane Doe", email: "j@acme.ca", phone: "5875550100", dob: "1980-04-21" });
    expect(p.businessName).toBe("Acme Inc");
    expect(p.claimedAnnualRevenue).toEqual({ min: 500_000, max: 1_000_000 });
    expect(normDomain(p.website)).toBe("acme.ca");
    expect(parseMoneyRange("1.2M+")).toEqual({ min: 1_200_000, max: 2_400_000 });
  });

  it("normalises before hashing", () => {
    expect(normEmail("J.Doe+x@googlemail.com")).toBe("jdoe@gmail.com");
    expect(normPhone("+1 (587) 555-0100")).toBe("5875550100");
    expect(normAddress("123 Main Street, Suite 4")).toBe("123 main st ste 4");
    expect(localHash("device", "abc", { JWT_SECRET: "one-secret" } as any)).not.toBe(localHash("device", "abc", { JWT_SECRET: "another" } as any));
    expect(localHash("device", "", {} as any)).toBeNull();
  });

  it("Boreal has no plans: all 15 checks are on, and there is no check 3", () => {
    expect([...allowedChecks()].map((k) => Number(k.slice(6))).sort((a, b) => a - b)).toEqual(Array.from({ length: 16 }, (_, i) => i + 1).filter((n) => n !== 3));
    expect(FRAUD_CHECKS).toHaveLength(15);
  });
});
