// BF_SERVER_TIMELINE_EVERY_CHANNEL_v358
import express from "express";
import request from "supertest";
import { beforeEach, describe, it, expect, vi } from "vitest";
import { answerBySql, callsMatching } from "./helpers/answerBySql.js";

const { queryMock, sendSMS } = vi.hoisted(() => ({ queryMock: vi.fn(), sendSMS: vi.fn(async () => ({ sid: "SM1" })) }));
vi.mock("../db.js", () => ({ pool: { query: queryMock }, runQuery: queryMock }));
vi.mock("../services/smsService.js", () => ({ sendSMS }));

import { loadCrmTimeline } from "../routes/crm/timeline.js";

async function timelineSql(isContact: boolean): Promise<string> {
  queryMock.mockReset();
  queryMock.mockImplementation(answerBySql([]));
  await loadCrmTimeline(isContact, "c-1", "BF");
  // BF_SERVER_v856_CRM_UNIFY - a company's timeline then reads its people and its applications' stage moves.
  expect(queryMock).toHaveBeenCalledTimes(isContact ? 1 : 3);
  expect(queryMock.mock.calls[0]![1]).toEqual(["c-1", "BF"]);
  return String(queryMock.mock.calls[0]![0]);
}

describe("contact timeline covers every channel", () => {
  it("gives logged calls their own kind for contacts and companies", async () => {
    for (const isContact of [true, false]) {
      expect((await timelineSql(isContact)).match(/SELECT 'call_logged' AS kind/g)?.length).toBe(1);
    }
  });

  it("labels messages by channel instead of calling everything SMS", async () => {
    const tl = await timelineSql(true);
    expect(tl).toContain("WHEN channel = 'messenger' THEN 'Talk to a human'");
    expect(tl).toContain("'Email reply in'");
    expect(tl).toContain("ELSE 'message' END) AS kind");
    expect(tl).toContain("WHERE contact_id = $1 AND (silo = $2 OR silo IS NULL)");
  });

  it("marketing email and engagement no longer use the kind the portal discards", async () => {
    const tl = await timelineSql(true);
    expect(tl).toContain("ELSE 'email_activity' END) AS kind");
    expect(tl).toContain("WHEN 'email_notice_sent' THEN 'Email sent'");
    expect(tl).toContain("'sms_marketing_sent','email_cascade_sent','email_notice_sent','automation')"); // BF_SERVER_v786_AUTOMATION_TIMELINE
  });
});

describe("records Graph sends and bridge SMS on the contact", () => {
  beforeEach(() => {
    queryMock.mockReset();
    queryMock.mockImplementation(answerBySql([]));
  });

  it("a successful Graph send lands on the recipients' timelines; a failed one does not", async () => {
    vi.resetModules();
    for (const k of ["MS_GRAPH_TENANT_ID", "MS_GRAPH_CLIENT_ID", "MS_GRAPH_CLIENT_SECRET"]) process.env[k] = "x";
    process.env.MS_GRAPH_SEND_AS = "submissions@boreal.test";
    let sendStatus = 202;
    const fetchMock = vi.fn(async (url: string) =>
      String(url).includes("login.microsoftonline.com")
        ? new Response(JSON.stringify({ access_token: "tok", expires_in: 3600 }), { status: 200 })
        : new Response("", { status: sendStatus }),
    );
    vi.stubGlobal("fetch", fetchMock);
    // The recorder is switched off under NODE_ENV=test so unrelated suites stay quiet.
    const prevEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      const { sendViaGraph } = await import("../services/email/graphSendService.js");
      expect((await sendViaGraph({ to: ["Ann@Acme.test"], subject: "Docs needed", bodyText: "x" })).ok).toBe(true);
      const recorded = callsMatching(queryMock, /INSERT INTO crm_timeline_events/);
      expect(recorded).toHaveLength(1);
      expect(String(recorded[0]![0])).toContain("'email_notice_sent', $2::jsonb FROM contacts c");
      expect(recorded[0]![1]).toEqual([["ann@acme.test"], JSON.stringify({ subject: "Docs needed", to: ["ann@acme.test"] })]);

      queryMock.mockClear();
      sendStatus = 500;
      expect((await sendViaGraph({ to: "ann@acme.test", subject: "Docs needed", bodyText: "x" })).ok).toBe(false);
      expect(callsMatching(queryMock, /INSERT INTO crm_timeline_events/)).toHaveLength(0);
    } finally {
      process.env.NODE_ENV = prevEnv;
      vi.unstubAllGlobals();
    }
  });

  it("a bridge SMS lands on the contact with that number", async () => {
    process.env.BACKEND_SERVICE_TOKEN = "test-token-v358";
    const { default: router } = await import("../routes/serviceBridge.js");
    const app = express();
    app.use(express.json());
    app.use("/api/service", router);
    const res = await request(app).post("/api/service/sms").set("x-backend-token", "test-token-v358").send({ to: "+1 (587) 555-0100", body: "Your quote is ready" });
    expect(res.status).toBe(200);
    expect(sendSMS).toHaveBeenCalledWith("+1 (587) 555-0100", "Your quote is ready", { silo: "BI" });
    const recorded = callsMatching(queryMock, /INSERT INTO crm_timeline_events/);
    expect(recorded).toHaveLength(1);
    expect(String(recorded[0]![0])).toContain("'sms_marketing_sent', $2::jsonb FROM contacts c");
    expect(recorded[0]![1]).toEqual(["15875550100", JSON.stringify({ body: "Your quote is ready", source: "bi_sequence" })]);
  });
});
