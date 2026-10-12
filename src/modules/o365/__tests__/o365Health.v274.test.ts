// BF_SERVER_O365_VISIBILITY_v274
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";
import { answerBySql } from "../../../__tests__/helpers/answerBySql.js";

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));
vi.mock("../../../db.js", async (orig) => {
  const real: any = await orig();
  const pool = { query: queryMock, connect: vi.fn() };
  return { ...real, pool, db: pool };
});

import { clearO365Failure, explainO365Failure, lastO365Failure, parseMicrosoftError, recordO365Failure } from "../o365Health.js";
import { getGraphForUser } from "../graphClient.js";
import { requireAuth } from "../../../middleware/auth.js";
import inbox from "../../../routes/crm/inbox.js";
import calendar from "../../../routes/calendar.js";
import o365Tokens from "../../../routes/o365Tokens.js";

describe("reading Microsoft errors", () => {
  it("finds the AADSTS code in a token endpoint error", () => {
    const body = JSON.stringify({ error: "invalid_client", error_description: "AADSTS7000222: The provided client secret keys for app 'c889' are expired.\r\nTrace ID: x" });
    expect(parseMicrosoftError(body)).toEqual({ code: "AADSTS7000222", message: "AADSTS7000222: The provided client secret keys for app 'c889' are expired." });
  });
  it("reads Graph error bodies", () => {
    expect(parseMicrosoftError(JSON.stringify({ error: { code: "ErrorAccessDenied", message: "Access is denied." } }))).toEqual({ code: "ErrorAccessDenied", message: "Access is denied." });
  });
});

describe("plain-English explanations", () => {
  const at = new Date().toISOString();
  it("names the expired server secret", () => expect(explainO365Failure({ stage: "refresh", status: 401, code: "AADSTS7000222", at })).toContain("MSAL_CLIENT_SECRET"));
  it("asks the user to reconnect when their sign-in expired", () => {
    expect(explainO365Failure({ stage: "refresh", status: 400, code: "AADSTS700082", at })).toContain("Reconnect Office 365");
    expect(explainO365Failure({ stage: "no_refresh_token", at })).toContain("Reconnect Office 365");
  });
  it("explains missing mail permission and missing configuration", () => {
    expect(explainO365Failure({ stage: "graph_inbox", status: 403, code: "ErrorAccessDenied", at })).toContain("permission");
    expect(explainO365Failure({ stage: "not_configured", at })).toContain("MSAL_CLIENT_SECRET");
  });
});

describe("per-user record", () => {
  it("logs, remembers and clears the last failure without tokens", () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    recordO365Failure("u1", { stage: "graph_inbox", status: 401, code: "InvalidAuthenticationToken" });
    expect(lastO365Failure("u1")?.code).toBe("InvalidAuthenticationToken");
    expect(String(log.mock.calls[0][0])).toContain("\"event\":\"o365_failure\"");
    clearO365Failure("u1");
    expect(lastO365Failure("u1")).toBeNull();
    log.mockRestore();
  });
});

describe("wiring", () => {
  const app = express();
  app.use(express.json());
  app.use("/api/crm/inbox", requireAuth, inbox);
  app.use("/api/calendar", calendar);
  app.use("/api/users/me", o365Tokens);
  const tokenFor = (sub: string) => jwt.sign({ sub, role: "Staff", tokenVersion: 0, tv: 0 }, process.env.JWT_SECRET!, { expiresIn: "5m" });

  const AADSTS_EXPIRED = JSON.stringify({ error: "invalid_grant", error_description: "AADSTS700082: The refresh token has expired due to inactivity." });
  const MSAL = ["MSAL_TENANT_ID", "MSAL_CLIENT_ID", "MSAL_CLIENT_SECRET"] as const;
  const saved = Object.fromEntries(MSAL.map((k) => [k, process.env[k]]));
  let errSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    Object.assign(process.env, { MSAL_TENANT_ID: "tenant", MSAL_CLIENT_ID: "client", MSAL_CLIENT_SECRET: "secret" });
    errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    queryMock.mockReset();
    queryMock.mockImplementation(answerBySql([
      // The "refresh" user's access token has expired; everyone else's is good for an hour.
      [/SELECT o365_access_token,/, (_s: string, p?: unknown[]) => ({
        rows: [{ o365_access_token: "at", o365_refresh_token: "rt", o365_access_token_expires_at: String(p?.[0]).startsWith("aaaaaaaa") ? new Date(0) : new Date(Date.now() + 3_600_000) }],
      })],
      [/SELECT o365_refresh_token FROM users WHERE id = \$1/, { rows: [{ o365_refresh_token: "rt" }] }],
    ]));
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (String(url).includes("login.microsoftonline.com")) return new Response(AADSTS_EXPIRED, { status: 400 });
      if (String(url).includes("/calendarView")) return new Response(JSON.stringify({ error: { code: "ErrorAccessDenied", message: "Access is denied." } }), { status: 403 });
      return new Response(JSON.stringify({ error: { code: "InvalidAuthenticationToken", message: "Lifetime validation failed." } }), { status: 401 });
    }));
  });
  afterEach(() => {
    errSpy.mockRestore();
    vi.unstubAllGlobals();
    for (const k of MSAL) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it("a failed token refresh is recorded with Microsoft's code", async () => {
    const userId = "aaaaaaaa-0000-4000-8000-000000000001";
    await getGraphForUser({ query: queryMock } as any, userId);
    expect(lastO365Failure(userId)).toMatchObject({ stage: "refresh", status: 400, code: "AADSTS700082" });
  });

  it("the inbox reports a rejected sign-in instead of returning an empty list", async () => {
    const userId = "bbbbbbbb-0000-4000-8000-000000000002";
    const r = await request(app).get("/api/crm/inbox").set("Authorization", `Bearer ${tokenFor(userId)}`);
    expect(r.status).toBe(401);
    expect(r.body.error).toBe("o365_reauth_required");
    expect(r.body.reason).toContain("Reconnect Office 365");
    expect(lastO365Failure(userId)).toMatchObject({ stage: "graph_inbox", status: 401 });
  });

  it("the calendar still renders but records why Graph failed", async () => {
    const userId = "cccccccc-0000-4000-8000-000000000003";
    const r = await request(app).get("/api/calendar/events").set("Authorization", `Bearer ${tokenFor(userId)}`);
    expect(r.status).toBe(200);
    expect(r.body.data).toEqual([]);
    expect(lastO365Failure(userId)).toMatchObject({ stage: "graph_calendar", status: 403, code: "ErrorAccessDenied" });
  });

  it("the refresh route answers 401 o365_reauth_required, and /o365-health explains it", async () => {
    const userId = "dddddddd-0000-4000-8000-000000000004";
    const r = await request(app).post("/api/users/me/o365-refresh").set("Authorization", `Bearer ${tokenFor(userId)}`);
    expect(r.status).toBe(401);
    expect(r.body).toMatchObject({ error: "o365_reauth_required", code: "AADSTS700082" });
    const h = await request(app).get("/api/users/me/o365-health").set("Authorization", `Bearer ${tokenFor(userId)}`);
    expect(h.status).toBe(200);
    expect(h.body.lastFailure).toMatchObject({ stage: "refresh", code: "AADSTS700082" });
    expect(h.body.explanation).toContain("Reconnect Office 365");
  });
});
