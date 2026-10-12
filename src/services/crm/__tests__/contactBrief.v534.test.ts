// BF_SERVER_BLOCK_v534_CRM_AI_BRIEF
import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import { mountRouter, staffToken } from "../../../__tests__/helpers/staffRouterApp.js";

const query = vi.fn();
vi.mock("../../../db.js", async () => ({
  ...(await vi.importActual<any>("../../../db.js")),
  pool: { query: (...args: unknown[]) => query(...args) },
}));
const askAI = vi.fn(async () => "Background: Roofing contractor in Laval.\n- Application in review");
vi.mock("../../../modules/ai/openai.service.js", async () => ({
  ...(await vi.importActual<any>("../../../modules/ai/openai.service.js")),
  askAI: (...args: unknown[]) => askAI(...(args as [])),
}));
const loadCrmTimeline = vi.fn();
vi.mock("../../../routes/crm/timeline.js", () => ({
  loadCrmTimeline: (...args: unknown[]) => loadCrmTimeline(...args),
  default: express.Router(),
}));

import { businessDomain, contactBrief, htmlToText, isPublicHost, timelineLines } from "../contactBrief.js";

beforeEach(() => { query.mockReset(); askAI.mockClear(); loadCrmTimeline.mockReset(); });

describe("v534 which business to research", () => {
  it("uses the company website, else a work email domain, never a free mailbox", () => {
    expect(businessDomain("https://www.bondit.us/about", "x@gmail.com")).toBe("bondit.us");
    expect(businessDomain("", "matthew@bondit.us")).toBe("bondit.us");
    expect(businessDomain(null, "someone@gmail.com")).toBeNull();
    expect(businessDomain(undefined, "a@shaw.ca")).toBeNull();
  });
  it("never fetches internal addresses", async () => {
    expect(await isPublicHost("localhost")).toBe(false);
    expect(await isPublicHost("10.0.0.5")).toBe(false);
    expect(await isPublicHost("server.internal")).toBe(false);
    expect(await isPublicHost("bf-server.azurewebsites.net")).toBe(false);
  });
  it("turns a homepage into plain text", () => {
    const text = htmlToText('<html><head><title>Bondit Media</title><meta name="description" content="Film finance"></head><body><script>x()</script><h1>We  fund films</h1></body></html>');
    expect(text).toContain("Bondit Media");
    expect(text).toContain("Film finance");
    expect(text).toContain("We fund films");
    expect(text).not.toContain("x()");
  });
});

describe("v534 contact brief", () => {
  it("feeds every timeline channel, applications and visits to the AI", async () => {
    loadCrmTimeline.mockResolvedValue([
      { kind: "email", ts: "2026-09-20T10:00:00Z", title: "Term sheet", body: "Sent the term sheet" },
      { kind: "call", ts: "2026-09-18T10:00:00Z", title: "outbound", body: "Call call.ended" },
      { kind: "meeting", ts: "2026-09-10T10:00:00Z", title: "Teams meeting: intro", body: "Discussed $250k line" },
    ]);
    query.mockImplementation(async (sql: string) => {
      if (sql.includes("FROM contacts c LEFT JOIN companies")) return { rows: [{ c: { name: "Jean Tremblay", email: "jean@gmail.com", ssn_encrypted: "SECRET", dob: "1980-01-01" }, co: { name: "Toitures Tremblay" } }] };
      if (sql.includes("FROM applications")) return { rows: [{ a: { name: "Toitures Tremblay", pipeline_state: "In Review", requested_amount: 250000, updated_at: "2026-09-21" } }] };
      if (sql.includes("FROM visitor_sessions")) return { rows: [{ sessions: 2, first_seen: "2026-09-01", last_seen: "2026-09-05", first_landing: "/equipment", first_referrer: "google" }] };
      return { rows: [] };
    });
    await contactBrief("c1", "BF");
    const prompt = String((askAI.mock.calls[0] as any[])[0][1].content);
    expect(prompt).toContain("[email] 2026-09-20: Term sheet - Sent the term sheet");
    expect(prompt).toContain("[meeting] 2026-09-10");
    expect(prompt).toContain("pipeline state: In Review");
    expect(prompt).toContain("2 website visit(s)");
    expect(prompt).not.toContain("SECRET");
    expect(prompt).not.toContain("1980-01-01");
    expect(prompt.indexOf("Teams meeting")).toBeLessThan(prompt.indexOf("Term sheet"));
  });
  it("says so plainly when there is nothing at all", async () => {
    loadCrmTimeline.mockResolvedValue([]);
    query.mockResolvedValue({ rows: [] });
    expect(await contactBrief("c1", "BF")).toMatch(/No activity/);
    expect(askAI).not.toHaveBeenCalled();
  });
  it("keeps the 60 most recent items", () => {
    const rows = Array.from({ length: 80 }, (_, index) => ({ kind: "note", ts: "2026-09-01", title: `n${index}`, body: "" }));
    expect(timelineLines(rows)).toHaveLength(60);
  });
});

describe("v534 wiring", () => {
  const crmApp = async () => mountRouter((await import("../../../routes/crm.js")).default, "/api/crm");

  it("the contact summary route uses the brief with the selected silo and the shared timeline", async () => {
    loadCrmTimeline.mockResolvedValue([{ kind: "note", ts: "2026-09-20T10:00:00Z", title: "Called back", body: "" }]);
    query.mockResolvedValue({ rows: [] });
    const res = await request(await crmApp()).get("/api/crm/contacts/c1/ai-summary")
      .set("Authorization", `Bearer ${staffToken()}`).set("X-Silo", "BI");
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).toContain("Roofing contractor in Laval");
    expect(loadCrmTimeline).toHaveBeenCalledWith(true, "c1", "BI");
    expect(askAI).toHaveBeenCalledTimes(1);
  });

  it("the company summary route uses the company brief and the shared timeline", async () => {
    loadCrmTimeline.mockResolvedValue([{ kind: "note", ts: "2026-09-20T10:00:00Z", title: "Called back", body: "" }]);
    query.mockResolvedValue({ rows: [] });
    const res = await request(await crmApp()).get("/api/crm/companies/co1/ai-summary")
      .set("Authorization", `Bearer ${staffToken()}`).set("X-Silo", "BF");
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).toContain("Roofing contractor in Laval");
    expect(loadCrmTimeline).toHaveBeenCalledWith(false, "co1", "BF");
  });
});
