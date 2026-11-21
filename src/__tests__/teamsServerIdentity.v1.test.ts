// BF_SERVER_TEAMS_SERVER_IDENTITY_v1 - the iPad app sends no Microsoft token; the stored sign-in is used instead.
import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { answerBySql } from "./helpers/answerBySql.js";

const STAFF_ID = "22222222-2222-4222-8222-222222222222";
const OID = "44444444-4444-4444-8444-444444444444";
const APP_ID = "c8890d6f-eb8f-4101-8336-5e8fca3303e0";
const JOIN = "https://teams.microsoft.com/l/meetup-join/19%3ameeting_srv%40thread.v2/0";

const h = vi.hoisted(() => ({ query: vi.fn(), createUserAndToken: vi.fn(), getTokenForTeamsUser: vi.fn(), fetch: vi.fn() }));
vi.mock("../db.js", async (orig) => ({ ...(await orig<Record<string, unknown>>()), pool: { query: h.query } }));
vi.mock("../middleware/auth.js", () => ({
  requireAuth: (req: any, _res: any, next: any) => { req.user = { userId: STAFF_ID, role: "Staff" }; next(); },
  requireAuthorization: () => (_req: any, _res: any, next: any) => next(),
}));
vi.mock("@azure/communication-identity", () => ({
  CommunicationIdentityClient: class { createUserAndToken = h.createUserAndToken; getTokenForTeamsUser = h.getTokenForTeamsUser; },
}));
vi.mock("../modules/o365/graphClient.js", () => ({ getGraphForUser: vi.fn() }));
vi.mock("../modules/automation/automationEngine.js", () => ({ emitAutomationEvent: vi.fn(async () => undefined) }));

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
const aad = (claims: Record<string, unknown>) => `${b64({ alg: "RS256" })}.${b64(claims)}.sig`;
const ENV = ["ACS_CONNECTION_STRING", "MSAL_CLIENT_ID", "ACS_TEAMS_CLIENT_ID", "MSAL_TENANT_ID", "MSAL_CLIENT_SECRET"];
const saved: Record<string, string | undefined> = {};
let refreshToken: string | null = "stored-rt";

async function app() {
  const a = express(); a.use(express.json());
  a.use("/api/meetings", (await import("../routes/meetings.js")).default);
  return a;
}

beforeEach(() => {
  for (const k of ENV) saved[k] = process.env[k];
  process.env.ACS_CONNECTION_STRING = "endpoint=https://acs-test.communication.azure.com/;accesskey=dGVzdA==";
  process.env.MSAL_CLIENT_ID = APP_ID; process.env.MSAL_TENANT_ID = "tenant-1"; process.env.MSAL_CLIENT_SECRET = "s3cret";
  delete process.env.ACS_TEAMS_CLIENT_ID;
  refreshToken = "stored-rt";
  h.query.mockReset();
  h.query.mockImplementation(answerBySql([
    [/SELECT o365_refresh_token FROM users/, () => ({ rows: [{ o365_refresh_token: refreshToken }] })],
    [/UPDATE users SET o365_refresh_token/, { rows: [] }],
    [/FROM users WHERE id/, { rows: [{ first_name: "Alex", last_name: "Tester", email: "alex@boreal.example", o365_user_email: null }] }],
    [/FROM teams_meetings tm/, { rows: [{ id: "m1", subject: "Lender review", join_url: JOIN, scheduled_at: new Date().toISOString(), scheduled_end_at: null, organizer_user_id: STAFF_ID }] }],
  ]));
  h.createUserAndToken.mockReset().mockResolvedValue({ token: "guest-token", expiresOn: new Date("2030-01-01T00:00:00Z"), user: { communicationUserId: "8:acs:guest" } });
  h.getTokenForTeamsUser.mockReset().mockResolvedValue({ token: "teams-token", expiresOn: new Date("2030-01-01T00:00:00Z") });
  h.fetch.mockReset().mockResolvedValue(new Response(JSON.stringify({ access_token: aad({ oid: OID, appid: APP_ID, upn: "alex@boreal.example" }), refresh_token: "rotated-rt" }), { status: 200 }));
  vi.stubGlobal("fetch", h.fetch);
});
afterEach(() => { vi.unstubAllGlobals(); for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });

describe("Teams identity from the stored Microsoft sign-in", () => {
  it("staff with no device token join as themselves", async () => {
    const r = await request(await app()).post("/api/meetings/acs-token").send({ joinUrl: JOIN });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ token: "teams-token", identity: "teams", acsUserId: "teams:" + OID });
    const body = String(h.fetch.mock.calls[0]![1].body);
    expect(body).toContain("grant_type=refresh_token");
    expect(decodeURIComponent(body)).toContain("https://auth.msft.communication.azure.com/Teams.ManageCalls");
    expect(h.query.mock.calls.some((c) => /UPDATE users SET o365_refresh_token/.test(String(c[0])) && c[1][1] === "rotated-rt")).toBe(true);
  });

  it("joins as themselves when Microsoft's token is encrypted, using the id_token's user id", async () => {
    const jwe = "eyJhbGciOiJSU0EtT0FFUCJ9.a.b.c.d";
    h.fetch.mockResolvedValue(new Response(JSON.stringify({ access_token: jwe, id_token: aad({ oid: OID }), refresh_token: "stored-rt" }), { status: 200 }));
    const r = await request(await app()).post("/api/meetings/acs-token").send({ joinUrl: JOIN });
    expect(r.body).toMatchObject({ token: "teams-token", identity: "teams", acsUserId: "teams:" + OID });
    expect(h.getTokenForTeamsUser).toHaveBeenCalledWith({ teamsUserAadToken: jwe, clientId: APP_ID, userObjectId: OID });
    expect(decodeURIComponent(String(h.fetch.mock.calls[0]![1].body))).toContain("openid");
  });

  it("says why it fell back to a guest", async () => {
    h.fetch.mockResolvedValue(new Response(JSON.stringify({ error: "invalid_grant", error_description: "AADSTS70000 bad grant" }), { status: 400 }));
    const r = await request(await app()).post("/api/meetings/acs-token").send({ joinUrl: JOIN });
    expect(r.body.identity).toBe("guest");
    expect(r.body.signInIssue).toMatch(/Microsoft refused \(400 invalid_grant\)/);
  });

  it("falls back to a guest when there is no stored sign-in", async () => {
    refreshToken = null;
    const r = await request(await app()).post("/api/meetings/acs-token").send({ joinUrl: JOIN });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ token: "guest-token", identity: "guest" });
    expect(h.fetch).not.toHaveBeenCalled();
  });

  it("falls back to a guest when Microsoft refuses", async () => {
    h.fetch.mockResolvedValue(new Response(JSON.stringify({ error: "invalid_grant", error_description: "AADSTS65001 consent" }), { status: 400 }));
    const r = await request(await app()).post("/api/meetings/acs-token").send({ joinUrl: JOIN });
    expect(r.body).toMatchObject({ identity: "guest" });
  });
});
