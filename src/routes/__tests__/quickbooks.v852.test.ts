// BF_SERVER_v852_CALC_QBO - /api/quickbooks: Admin-only connection routes (status, connect with a single-use state,
// the Intuit callback, disconnect with revoke), the tax code setting, and the per-application invoice + Retry.
// Database faked by SQL content; Intuit faked through a stubbed fetch.
import request from "supertest";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { answerBySql, callsMatching, type SqlRule } from "../../__tests__/helpers/answerBySql.js";
import { mountRouter, staffToken, STAFF_USER_ID } from "../../__tests__/helpers/staffRouterApp.js";
import { APP_ID, QBO_ENV, connectionRow, fakeIntuit } from "../../services/quickbooks/__tests__/qboFixtures.js";
import { decryptToken } from "../../services/quickbooks/qboCrypto.js";

const h = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("../../db.js", async () => ({ ...(await vi.importActual<any>("../../db.js")), pool: { query: h.query }, dbQuery: h.query }));

async function app() {
  return mountRouter((await import("../quickbooks.js")).default, "/api/quickbooks");
}
const admin = () => "Bearer " + staffToken("Admin");
const staff = () => "Bearer " + staffToken("Staff");

function db(rules: SqlRule[] = []) {
  h.query.mockImplementation(answerBySql(rules));
}

function setEnv(on: boolean) {
  for (const [k, v] of Object.entries(QBO_ENV)) {
    if (on) process.env[k] = v; else delete process.env[k];
  }
}

beforeEach(() => {
  h.query.mockReset();
  db();
  setEnv(true);
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  setEnv(false);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("status", () => {
  it("not configured: greyed out with the reason, and nothing else is read", async () => {
    setEnv(false);
    const r = await request(await app()).get("/api/quickbooks/status").set("Authorization", admin());
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ configured: false, connected: false, missing: ["QBO_CLIENT_ID", "QBO_CLIENT_SECRET", "QBO_TOKEN_ENCRYPTION_KEY"], environment: "sandbox" });
    expect(r.body.reason).toMatch(/not set up/);
    expect(callsMatching(h.query, /qbo_/)).toHaveLength(0);
  });

  it("is Admin only", async () => {
    const r = await request(await app()).get("/api/quickbooks/status").set("Authorization", staff());
    expect(r.status).toBe(403);
    const c = await request(await app()).post("/api/quickbooks/connect").set("Authorization", staff());
    expect(c.status).toBe(403);
    const d = await request(await app()).post("/api/quickbooks/disconnect").set("Authorization", staff());
    expect(d.status).toBe(403);
  });

  it("connected: company, who connected it, tax code and invoice counts (never the tokens)", async () => {
    db([
      [/FROM qbo_connections/, { rows: [connectionRow()] }],
      [/FROM qbo_fee_invoices/, { rows: [{ open: 2, paid: 5, failed: 1 }] }],
      [/FROM users WHERE id::text/, { rows: [{ name: "Todd W" }] }],
      [/SELECT value FROM settings/, { rows: [{ value: "5" }] }],
    ]);
    const r = await request(await app()).get("/api/quickbooks/status").set("Authorization", admin());
    expect(r.body).toMatchObject({ configured: true, connected: true, taxCode: "5", invoices: { open: 2, paid: 5, failed: 1 } });
    expect(r.body.connection).toMatchObject({ realmId: "9341452", companyName: "Boreal Sandbox Co", connectedByName: "Todd W", environment: "sandbox" });
    expect(JSON.stringify(r.body)).not.toMatch(/access_token|refresh_token|v1:/);
  });
});

describe("connect and the Intuit callback", () => {
  it("connect returns the Intuit sign-in URL with a single-use state stored hashed for this user", async () => {
    const r = await request(await app()).post("/api/quickbooks/connect").set("Authorization", admin());
    expect(r.status).toBe(200);
    const url = new URL(r.body.url);
    expect(url.origin + url.pathname).toBe("https://appcenter.intuit.com/connect/oauth2");
    expect(url.searchParams.get("client_id")).toBe("client-id-test");
    expect(url.searchParams.get("scope")).toBe("com.intuit.quickbooks.accounting");
    expect(url.searchParams.get("redirect_uri")).toBe("https://server.boreal.financial/api/quickbooks/oauth/callback");
    const state = url.searchParams.get("state")!;
    expect(state.length).toBeGreaterThan(30);
    const saved = callsMatching(h.query, /INSERT INTO qbo_oauth_states/)[0]![1] as unknown[];
    expect(saved[0]).toBe(createHash("sha256").update(state).digest("hex"));
    expect(saved[1]).toBe(STAFF_USER_ID);
    expect(String(r.headers["set-cookie"])).toMatch(/qbo_oauth_state=.*HttpOnly/);
  });

  it("refuses to connect while not configured", async () => {
    setEnv(false);
    const r = await request(await app()).post("/api/quickbooks/connect").set("Authorization", admin());
    expect(r.status).toBe(409);
  });

  it("a callback from another browser (no matching cookie) is refused without calling Intuit", async () => {
    const intuit = fakeIntuit();
    vi.stubGlobal("fetch", intuit.fetchImpl);
    const r = await request(await app()).get("/api/quickbooks/oauth/callback?code=abc&state=s1&realmId=9341452").set("Cookie", "qbo_oauth_state=other");
    expect(r.status).toBe(302);
    expect(r.headers.location).toBe("https://staff.boreal.financial/settings/quickbooks?quickbooks=error");
    expect(intuit.calls).toHaveLength(0);
  });

  it("a used or expired state is refused", async () => {
    db([[/UPDATE qbo_oauth_states/, { rows: [] }]]);
    const intuit = fakeIntuit();
    vi.stubGlobal("fetch", intuit.fetchImpl);
    const r = await request(await app()).get("/api/quickbooks/oauth/callback?code=abc&state=s1&realmId=9341452").set("Cookie", "qbo_oauth_state=s1");
    expect(r.headers.location).toMatch(/quickbooks=error$/);
    expect(intuit.calls).toHaveLength(0);
  });

  it("a good callback trades the code and stores the tokens encrypted", async () => {
    db([[/UPDATE qbo_oauth_states/, { rows: [{ user_id: STAFF_USER_ID }] }]]);
    const intuit = fakeIntuit([(c) => (c.url.startsWith("https://oauth.platform.intuit.com/") ? { body: { access_token: "acc-new", refresh_token: "ref-new", expires_in: 3600, x_refresh_token_expires_in: 8640000 } } : undefined)]);
    vi.stubGlobal("fetch", intuit.fetchImpl);
    // after the INSERT the connection exists for the company-name lookup
    h.query.mockImplementation(answerBySql([
      [/UPDATE qbo_oauth_states/, { rows: [{ user_id: STAFF_USER_ID }] }],
      [/FROM qbo_connections WHERE id/, { rows: [connectionRow()] }],
    ]));
    const r = await request(await app()).get("/api/quickbooks/oauth/callback?code=the-code&state=s1&realmId=9341452").set("Cookie", "qbo_oauth_state=s1");
    expect(r.headers.location).toBe("https://staff.boreal.financial/settings/quickbooks?quickbooks=connected");
    const token = intuit.calls.find((c) => c.url.startsWith("https://oauth.platform.intuit.com/"))!;
    expect(token.body).toMatchObject({ grant_type: "authorization_code", code: "the-code", redirect_uri: "https://server.boreal.financial/api/quickbooks/oauth/callback" });
    const params = callsMatching(h.query, /INSERT INTO qbo_connections/)[0]![1] as unknown[];
    expect(params[1]).toBe("9341452");
    expect(params[2]).toBe("sandbox");
    expect(String(params[3])).not.toContain("acc-new");
    expect(decryptToken(String(params[3]), QBO_ENV)).toBe("acc-new");
    expect(decryptToken(String(params[4]), QBO_ENV)).toBe("ref-new");
    expect(params[7]).toBe(STAFF_USER_ID);
  });
});

describe("disconnect and settings", () => {
  it("revokes the refresh token at Intuit and forgets the connection", async () => {
    db([[/FROM qbo_connections WHERE id/, { rows: [connectionRow()] }]]);
    const intuit = fakeIntuit();
    vi.stubGlobal("fetch", intuit.fetchImpl);
    const r = await request(await app()).post("/api/quickbooks/disconnect").set("Authorization", admin());
    expect(r.body).toEqual({ ok: true, revoked: true });
    const revoke = intuit.calls.find((c) => c.url === "https://developer.api.intuit.com/v2/oauth2/tokens/revoke")!;
    expect(revoke.body).toEqual({ token: "refresh-1" });
    expect(callsMatching(h.query, /DELETE FROM qbo_connections/)).toHaveLength(1);
  });

  it("saves or clears the tax code, and rejects junk", async () => {
    let r = await request(await app()).put("/api/quickbooks/settings").set("Authorization", admin()).send({ taxCode: "13" });
    expect(r.body).toEqual({ ok: true, taxCode: "13" });
    expect(callsMatching(h.query, /INSERT INTO settings/)[0]![1]).toEqual(["quickbooks.tax_code", "13"]);
    r = await request(await app()).put("/api/quickbooks/settings").set("Authorization", admin()).send({ taxCode: "" });
    expect(r.body.taxCode).toBeNull();
    expect(callsMatching(h.query, /DELETE FROM settings/)).toHaveLength(1);
    r = await request(await app()).put("/api/quickbooks/settings").set("Authorization", admin()).send({ taxCode: "'; drop" });
    expect(r.status).toBe(400);
  });
});

describe("the application's invoice", () => {
  const row = { application_id: APP_ID, qbo_invoice_id: "130", doc_number: "1042", qbo_customer_id: "58", amount: "5000.00", status: "open", qbo_payment_id: null, sync_state: "failed", attempts: 2, last_error: "QuickBooks POST invoice failed (400)", synced_at: "2026-10-23T10:00:00Z" };

  it("shows number, amount and status to staff, with the sync error for Retry", async () => {
    db([[/FROM applications/, { rows: [{ id: APP_ID }] }], [/FROM qbo_fee_invoices WHERE application_id/, { rows: [row] }]]);
    const r = await request(await app()).get(`/api/quickbooks/applications/${APP_ID}/invoice`).set("Authorization", staff());
    expect(r.status).toBe(200);
    expect(r.body.invoice).toMatchObject({ docNumber: "1042", amount: 5000, status: "open", syncState: "failed", lastError: "QuickBooks POST invoice failed (400)", url: "https://app.sandbox.qbo.intuit.com/app/invoice?txnId=130" });
  });

  it("answers 404 for a file outside the caller's silo", async () => {
    db([[/FROM applications/, { rows: [] }]]);
    const r = await request(await app()).get(`/api/quickbooks/applications/${APP_ID}/invoice`).set("Authorization", staff());
    expect(r.status).toBe(404);
  });

  it("not configured: no invoice and no error", async () => {
    setEnv(false);
    const r = await request(await app()).get(`/api/quickbooks/applications/${APP_ID}/invoice`).set("Authorization", staff());
    expect(r.body).toEqual({ ok: true, configured: false, invoice: null });
  });

  it("Retry resets the attempts and syncs now", async () => {
    let paid = false;
    h.query.mockImplementation(answerBySql([
      [/FROM applications a|FROM applications\s+WHERE id::text = \$1 AND/, { rows: [{ id: APP_ID }] }],
      [/FROM media_fee_agreements WHERE application_id/, { rows: [{ status: "signed", fee_percent: null, fee_amount: null, signer_name: null, signer_email: null }] }],
      [/FROM applications WHERE id::text/, { rows: [{ id: APP_ID, name: "N", requested_amount: "250000", funded_amount: "250000", funded_at: "2026-10-20T15:00:00Z", pipeline_state: "Accepted", metadata: {} }] }],
      [/SET status = 'paid'/, () => { paid = true; return { rows: [] }; }],
      [/FROM qbo_fee_invoices WHERE application_id/, () => ({ rows: [paid ? { ...row, status: "paid", sync_state: "ok", last_error: null } : row] })],
      [/FROM qbo_connections WHERE id/, { rows: [connectionRow()] }],
      [/INSERT INTO qbo_fee_invoices \(application_id, sync_state, lease_until/, { rows: [{ application_id: APP_ID }] }],
    ]));
    const intuit = fakeIntuit();
    vi.stubGlobal("fetch", intuit.fetchImpl);
    const r = await request(await app()).post(`/api/quickbooks/applications/${APP_ID}/retry`).set("Authorization", staff());
    expect(r.body).toMatchObject({ ok: true, action: "paid" });
    expect(r.body.invoice).toMatchObject({ status: "paid", syncState: "ok" });
    expect(callsMatching(h.query, /SET attempts = 0, sync_state = 'queued'/)).toHaveLength(1);
    expect(intuit.calls.some((c) => c.path.endsWith("/payment"))).toBe(true);
  });
});
