// BF_SERVER_REPORTS6_10_v780 / BF_SERVER_SMS_KEYWORDS_v780 / BF_SERVER_MMS_DIAG_v780
import { describe, it, expect, vi } from "vitest";
import express from "express";
import request from "supertest";
import { readFileSync } from "node:fs";

const writes: Array<{ sql: string; params: unknown[] }> = [];
vi.mock("../db.js", async (orig) => {
  const real: any = await orig();
  const query = async (sql: string, params: unknown[] = []) => { writes.push({ sql, params }); return { rows: [], rowCount: 1 }; };
  return { ...real, pool: { query } };
});
let role = "Admin";
vi.mock("../middleware/auth.js", () => ({ requireAuth: (req: any, _res: any, next: any) => { req.user = { id: "u1", role }; next(); } }));
import { smsKeywordReply } from "../routes/smsInboundWebhook.js";
import reportsSection from "../routes/reportsSection.js";
import { DATA } from "../services/reports/data.js";

describe("SMS keywords match what Boreal registered with Twilio", () => {
  it("STOP and French ARRET opt out with the registered wording", () => {
    expect(smsKeywordReply("STOP")).toEqual({ kind: "out", text: "Boreal Financial: You've been unsubscribed and won't receive any more messages. Reply START to resubscribe." });
    expect(smsKeywordReply("ARRET")?.kind).toBe("out");
  });
  it("HELP, AIDE and INFO get the support reply; normal words get nothing", () => {
    expect(smsKeywordReply("HELP")?.text).toContain("Standard message & data rates may apply");
    expect(smsKeywordReply("AIDE")?.text).toContain("Répondez ARRET");
    expect(smsKeywordReply("INFO")?.text).toContain(" / ");
    expect(smsKeywordReply("THANKS")).toBeNull();
  });
  it("YES only resubscribes someone who is opted out (otherwise it reaches staff as a normal message)", () => {
    const src = readFileSync("src/routes/smsInboundWebhook.ts", "utf8");
    expect(src).toContain('if (!cur?.rows[0]?.out) act = null;');
  });
  it("image failures are logged with a reason", () => {
    const src = readFileSync("src/routes/communications.ts", "utf8");
    for (const r of ["[mms-media] refused", "[mms-media] no media on message", "[mms-media] twilio fetch failed", "[mms-media] stored copy unreadable"]) expect(src).toContain(r);
  });
});

describe("reports 6-10", () => {
  it("are all registered", () => {
    for (const k of ["pipeline_movement", "average_deal_size", "goals", "meetings", "tasks_report"]) expect(typeof (DATA as any)[k]).toBe("function");
  });
  it("only an Admin can set goals, and amounts are checked", async () => {
    const app = express(); app.use(express.json()); app.use("/api/reports", reportsSection);
    role = "Staff";
    expect((await request(app).put("/api/reports/goals").send({ userId: "00000000-0000-0000-0000-000000000099", fundingTarget: 1 })).status).toBe(403);
    role = "Admin";
    expect((await request(app).put("/api/reports/goals").send({ userId: "00000000-0000-0000-0000-000000000099", fundingTarget: -5 })).status).toBe(400);
    writes.length = 0;
    const ok = await request(app).put("/api/reports/goals").send({ userId: "00000000-0000-0000-0000-000000000099", fundingTarget: 500000, commissionTarget: "" });
    expect(ok.status).toBe(200);
    expect(writes[0]!.sql).toContain("INSERT INTO report_goals");
    expect(writes[0]!.params).toEqual(["00000000-0000-0000-0000-000000000099", 500000, null]);
  });
});
