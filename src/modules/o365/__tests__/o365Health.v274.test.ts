// BF_SERVER_O365_VISIBILITY_v274
import { describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import { clearO365Failure, explainO365Failure, lastO365Failure, parseMicrosoftError, recordO365Failure } from "../o365Health.js";

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
  it("refresh, inbox, calendar and the refresh route all report failures", () => {
    const graph = fs.readFileSync("src/modules/o365/graphClient.ts", "utf8");
    expect(graph).toContain('recordO365Failure(userId, { stage: "refresh"');
    const inbox = fs.readFileSync("src/routes/crm/inbox.ts", "utf8");
    expect(inbox).not.toContain("if (!r.ok) return [];");
    expect(inbox).toContain('error: "o365_reauth_required"');
    expect(fs.readFileSync("src/routes/calendar.ts", "utf8")).toContain("noteCalendarFailure(req, err)");
    const tokens = fs.readFileSync("src/routes/o365Tokens.ts", "utf8");
    expect(tokens).toContain('return res.status(401).json({ error: "o365_reauth_required"');
    expect(tokens).toContain('router.get("/o365-health"');
  });
});
