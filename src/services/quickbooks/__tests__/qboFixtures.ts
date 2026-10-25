// BF_SERVER_v852_CALC_QBO - a fake Intuit (token endpoint + Accounting API) for the QuickBooks tests. No test reaches
// the real Intuit: every call goes through this fetch, which records what was asked.
import { encryptToken } from "../qboCrypto.js";

export const QBO_ENV = {
  QBO_CLIENT_ID: "client-id-test",
  QBO_CLIENT_SECRET: "client-secret-test",
  QBO_TOKEN_ENCRYPTION_KEY: "k".repeat(40),
  QBO_ENVIRONMENT: "sandbox",
} as Record<string, string | undefined>;

export const APP_ID = "0b6f7c1e-1111-4222-8333-444455556666";

export type Call = { method: string; url: string; path: string; query: URLSearchParams; body: any };

export function connectionRow(over: Partial<Record<string, unknown>> = {}) {
  return {
    realm_id: "9341452",
    environment: "sandbox",
    access_token_enc: encryptToken("access-1", QBO_ENV),
    refresh_token_enc: encryptToken("refresh-1", QBO_ENV),
    access_expires_at: new Date(Date.now() + 50 * 60 * 1000).toISOString(),
    refresh_expires_at: new Date(Date.now() + 90 * 86400 * 1000).toISOString(),
    connected_by: "00000000-0000-4000-8000-0000000000a1",
    company_name: "Boreal Sandbox Co",
    connected_at: new Date(Date.now() - 86400 * 1000).toISOString(),
    first_connected_at: new Date(Date.now() - 86400 * 1000).toISOString(),
    ...over,
  };
}

type Handler = (call: Call) => { status?: number; body: unknown } | undefined;

/** A fake fetch. Handlers are tried in order; the defaults answer like an empty sandbox company. */
export function fakeIntuit(handlers: Handler[] = []) {
  const calls: Call[] = [];
  const defaults: Handler[] = [
    (c) => (c.url.startsWith("https://oauth.platform.intuit.com/") ? { body: { access_token: "access-2", refresh_token: "refresh-2", expires_in: 3600, x_refresh_token_expires_in: 8640000 } } : undefined),
    (c) => (c.url.startsWith("https://developer.api.intuit.com/v2/oauth2/tokens/revoke") ? { body: {} } : undefined),
    (c) => (c.path.endsWith("/query") ? { body: { QueryResponse: /from Account/.test(c.query.get("query") ?? "") ? { Account: [{ Id: "79", Name: "Fees" }] } : {} } } : undefined),
    (c) => (c.method === "POST" && c.path.endsWith("/customer") ? { body: { Customer: { Id: "58" } } } : undefined),
    (c) => (c.method === "POST" && c.path.endsWith("/item") ? { body: { Item: { Id: "21" } } } : undefined),
    (c) => (c.method === "POST" && c.path.endsWith("/invoice") && !c.body?.sparse
      ? { body: { Invoice: { Id: "130", DocNumber: "1042", TotalAmt: c.body.Line[0].Amount, Balance: c.body.Line[0].Amount, SyncToken: "0", CustomerRef: c.body.CustomerRef } } } : undefined),
    (c) => (c.method === "GET" && /\/invoice\/130$/.test(c.path)
      ? { body: { Invoice: { Id: "130", DocNumber: "1042", SyncToken: "3", TotalAmt: 5000, Balance: 5000, CustomerRef: { value: "58" }, Line: [{ Amount: 5000, SalesItemLineDetail: { ItemRef: { value: "21" } } }] } } } : undefined),
    (c) => (c.method === "POST" && c.path.endsWith("/invoice") && c.body?.sparse
      ? { body: { Invoice: { Id: "130", DocNumber: "1042", SyncToken: "4", TotalAmt: c.body.Line[0].Amount, Balance: c.body.Line[0].Amount, CustomerRef: { value: "58" } } } } : undefined),
    (c) => (c.method === "POST" && c.path.endsWith("/payment") ? { body: { Payment: { Id: "200" } } } : undefined),
    (c) => (/\/companyinfo\//.test(c.path) ? { body: { CompanyInfo: { CompanyName: "Boreal Sandbox Co" } } } : undefined),
  ];
  const fetchImpl = async (url: string, init: { method?: string; body?: string } = {}) => {
    const u = new URL(url);
    let body: any = undefined;
    if (typeof init.body === "string") {
      try { body = JSON.parse(init.body); } catch { body = Object.fromEntries(new URLSearchParams(init.body)); }
    }
    const call: Call = { method: init.method ?? "GET", url, path: u.pathname, query: u.searchParams, body };
    calls.push(call);
    for (const h of [...handlers, ...defaults]) {
      const out = h(call);
      if (!out) continue;
      const status = out.status ?? 200;
      const text = JSON.stringify(out.body);
      return { ok: status >= 200 && status < 300, status, json: async () => JSON.parse(text), text: async () => text };
    }
    return { ok: false, status: 404, json: async () => ({}), text: async () => "not found" };
  };
  return { fetchImpl, calls };
}
