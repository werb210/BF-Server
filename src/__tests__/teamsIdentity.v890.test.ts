// BF_SERVER_v890_TEAMS_IDENTITY - staff join Teams meetings as themselves; clients and fallbacks join as guests.
import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { answerBySql } from "./helpers/answerBySql.js";

const STAFF_ID = "22222222-2222-4222-8222-222222222222";
const OID = "44444444-4444-4444-8444-444444444444";
const APP_ID = "c8890d6f-eb8f-4101-8336-5e8fca3303e0";
const JOIN = "https://teams.microsoft.com/l/meetup-join/19%3ameeting_test%40thread.v2/0";

const h = vi.hoisted(() => ({ query: vi.fn(), createUserAndToken: vi.fn(), getTokenForTeamsUser: vi.fn() }));
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

async function app() {
  const a = express(); a.use(express.json());
  a.use("/api/meetings", (await import("../routes/meetings.js")).default);
  return a;
}

const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  for (const k of ["ACS_CONNECTION_STRING", "MSAL_CLIENT_ID", "ACS_TEAMS_CLIENT_ID"]) saved[k] = process.env[k];
  process.env.ACS_CONNECTION_STRING = "endpoint=https://acs-test.communication.azure.com/;accesskey=dGVzdA==";
  process.env.MSAL_CLIENT_ID = APP_ID;
  delete process.env.ACS_TEAMS_CLIENT_ID;
  h.query.mockReset();
  h.query.mockImplementation(answerBySql([
    [/FROM users WHERE id/, { rows: [{ first_name: "Alex", last_name: "Tester", email: "alex@boreal.example", o365_user_email: null }] }],
    [/FROM teams_meetings tm/, { rows: [{ id: "m1", subject: "Lender review", join_url: JOIN, scheduled_at: new Date().toISOString(), scheduled_end_at: null, organizer_user_id: STAFF_ID }] }],
  ]));
  h.createUserAndToken.mockReset().mockResolvedValue({ token: "guest-token", expiresOn: new Date("2030-01-01T00:00:00Z"), user: { communicationUserId: "8:acs:guest" } });
  h.getTokenForTeamsUser.mockReset().mockResolvedValue({ token: "teams-token", expiresOn: new Date("2030-01-01T00:00:00Z") });
});
afterEach(() => { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });

describe("Teams identity", () => {
  it("reads the claims ACS needs", async () => {
    const { teamsTokenClaims } = await import("../services/teams/inAppMeetings.js");
    expect(teamsTokenClaims(aad({ oid: OID, appid: APP_ID, upn: "Alex@Boreal.example" }))).toEqual({ oid: OID, appId: APP_ID, email: "alex@boreal.example" });
    expect(teamsTokenClaims("nope")).toBeNull();
    expect(teamsTokenClaims(aad({ oid: "x", appid: APP_ID }))).toBeNull();
  });

  it("a staff member with their Microsoft token joins as themselves", async () => {
    const r = await request(await app()).post("/api/meetings/acs-token").send({ joinUrl: JOIN, teamsToken: aad({ oid: OID, appid: APP_ID, upn: "alex@boreal.example" }) });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ token: "teams-token", identity: "teams", acsUserId: "teams:" + OID });
    expect(h.getTokenForTeamsUser).toHaveBeenCalledWith(expect.objectContaining({ clientId: APP_ID, userObjectId: OID }));
    expect(h.createUserAndToken).not.toHaveBeenCalled();
  });

  it("someone else's token, or a token for another app, falls back to a guest join", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const a = await app();
    const other = await request(a).post("/api/meetings/acs-token").send({ joinUrl: JOIN, teamsToken: aad({ oid: OID, appid: APP_ID, upn: "someone@else.example" }) });
    expect(other.body).toMatchObject({ token: "guest-token", identity: "guest" });
    const wrongApp = await request(a).post("/api/meetings/acs-token").send({ joinUrl: JOIN, teamsToken: aad({ oid: OID, appid: "11111111-1111-4111-8111-111111111111", upn: "alex@boreal.example" }) });
    expect(wrongApp.body).toMatchObject({ identity: "guest" });
    expect(h.getTokenForTeamsUser).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("ACS refusing the exchange (permissions not granted yet) still lets them join as a guest", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    h.getTokenForTeamsUser.mockRejectedValue(new Error("Forbidden"));
    const r = await request(await app()).post("/api/meetings/acs-token").send({ joinUrl: JOIN, teamsToken: aad({ oid: OID, appid: APP_ID, upn: "alex@boreal.example" }) });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ token: "guest-token", identity: "guest" });
  });
});
