// BF_SERVER_GOOGLE_ADS_DIAGNOSTICS_v1 - admin "test Google Ads now" endpoint
// reports which of the five credentials are set and, when present, does a live
// token exchange + API call, mapping failures to a plain diagnosis. No secrets.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";

const h = vi.hoisted(() => ({ query: vi.fn(async () => ({ rows: [], rowCount: 0 })) }));
vi.mock("../db.js", async (orig) => ({ ...(await orig() as any), pool: { query: h.query, connect: vi.fn() }, runQuery: h.query, dbQuery: h.query }));
import adminRouter from "../routes/admin.js";
import { googleAdsDiagnostics } from "../services/googleAdsService.js";

const sign = (role: string) => "Bearer " + jwt.sign({ sub: "71717171-7171-4171-8171-717171717171", role, tokenVersion: 0, tv: 0 }, process.env.JWT_SECRET as string);
const app = express();
app.use(express.json());
app.use("/api/admin", adminRouter);

const SECRETS = {
  GOOGLE_ADS_DEVELOPER_TOKEN: "dev-token-SECRET",
  GOOGLE_ADS_CLIENT_ID: "client-id-SECRET",
  GOOGLE_ADS_CLIENT_SECRET: "client-secret-SECRET",
  GOOGLE_ADS_REFRESH_TOKEN: "refresh-token-SECRET",
  GOOGLE_ADS_CUSTOMER_ID: "123-456-7890",
};
function setAll(over: Partial<Record<keyof typeof SECRETS | "GOOGLE_ADS_LOGIN_CUSTOMER_ID", string>> = {}) {
  for (const [k, v] of Object.entries({ ...SECRETS, ...over })) vi.stubEnv(k, v as string);
}
function google(answer: { token?: number; search?: number; body?: string }) {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (String(url).includes("oauth2")) {
      return answer.token && answer.token >= 400
        ? new Response("invalid_grant", { status: answer.token })
        : new Response(JSON.stringify({ access_token: "at", expires_in: 3600 }), { status: 200 });
    }
    return new Response(answer.body ?? "{}", { status: answer.search ?? 200 });
  }));
}

beforeEach(() => { for (const k of [...Object.keys(SECRETS), "GOOGLE_ADS_LOGIN_CUSTOMER_ID"]) vi.stubEnv(k, ""); });
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe("google ads diagnostics", () => {
  it("registers the admin endpoint, guarded", async () => {
    const admin = await request(app).post("/api/admin/google-ads-diagnostics").set("Authorization", sign("Admin"));
    expect(admin.status).toBe(200);
    expect(admin.body.diagnosis).toMatch(/^missing_env: /);
    expect((await request(app).post("/api/admin/google-ads-diagnostics").set("Authorization", sign("Staff"))).status).toBe(403);
    expect((await request(app).post("/api/admin/google-ads-diagnostics")).status).toBe(401);
  });

  it("reports each of the five credentials + login-customer-id", async () => {
    setAll({ GOOGLE_ADS_CLIENT_SECRET: "", GOOGLE_ADS_LOGIN_CUSTOMER_ID: "999-000-1111" });
    const out = await googleAdsDiagnostics();
    expect(out).toMatchObject({
      devTokenSet: true, clientIdSet: true, clientSecretSet: false, refreshTokenSet: true, customerIdSet: true, loginCustomerIdSet: true,
      customerId: "1234567890", loginCustomerId: "9990001111", missing: ["GOOGLE_ADS_CLIENT_SECRET"],
      diagnosis: "missing_env: GOOGLE_ADS_CLIENT_SECRET",
    });
  });

  it("maps the common failures to plain diagnoses", async () => {
    setAll();
    google({ search: 403, body: "DEVELOPER_TOKEN_NOT_APPROVED" });
    expect((await googleAdsDiagnostics()).diagnosis).toBe("developer_token_not_approved_for_production");
    google({ token: 400 });
    expect((await googleAdsDiagnostics()).diagnosis).toBe("refresh_token_or_oauth_client_invalid");
    google({ search: 404, body: "not found" });
    expect((await googleAdsDiagnostics()).diagnosis).toBe("customer_id_not_found_or_not_linked");
    google({ search: 200 });
    expect(await googleAdsDiagnostics()).toMatchObject({ diagnosis: "ok", tokenExchange: "ok", apiCall: "ok" });
  });

  it("never returns the secrets", async () => {
    setAll();
    google({ search: 200 });
    const r = await request(app).post("/api/admin/google-ads-diagnostics").set("Authorization", sign("Admin"));
    expect(r.body.diagnosis).toBe("ok");
    expect(JSON.stringify(r.body)).not.toContain("SECRET");
  });
});
