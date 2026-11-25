// BF_SERVER_BI_SENDGRID_FORWARD_v1 - Boreal Risk Management email events go on to BI-Server, signed bytes untouched.
import crypto from "node:crypto";
import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { answerBySql, callsMatching } from "../../__tests__/helpers/answerBySql.js";

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));
vi.mock("../../db.js", () => ({ pool: { query: queryMock }, runQuery: queryMock }));
vi.mock("../../modules/automation/automationEngine.js", () => ({ emitAutomationEvent: vi.fn(async () => undefined) }));

const keys = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const PUBLIC_KEY = keys.publicKey.export({ format: "der", type: "spki" }).toString("base64");
const TIMELINE = /INSERT INTO crm_timeline_events/;
const FLOW_JOB = "flow:cf53f3ce-5157-4f40-b536-b2ed836aa18e:n2";

async function post(events: unknown[]) {
  const { default: router } = await import("../sendgridWebhook.js");
  const app = express();
  app.use("/webhook", router);
  const body = JSON.stringify(events);
  const ts = String(Math.floor(Date.now() / 1000));
  const signature = crypto.createSign("sha256").update(ts + body).sign(keys.privateKey, "base64");
  const res = await request(app).post("/webhook").set("Content-Type", "application/json")
    .set("X-Twilio-Email-Event-Webhook-Signature", signature).set("X-Twilio-Email-Event-Webhook-Timestamp", ts).send(body);
  return { res, body, ts, signature };
}

describe("BI email events are passed to BI-Server", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    process.env.SENDGRID_WEBHOOK_PUBLIC_KEY = PUBLIC_KEY;
    process.env.BI_SERVER_URL = "https://bi.example.test/";
    process.env.JWT_SECRET = "jwt-secret-for-tests";
    queryMock.mockReset();
    queryMock.mockImplementation(answerBySql([[/SELECT id FROM contacts/, () => ({ rows: [{ id: "c-bf" }] })]]));
    fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
  });
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it("forwards the exact body and signature when a flow event is in the batch, and BF skips it", async () => {
    const { res, body, ts, signature } = await post([
      { email: "lender@bank.test", event: "open", job_id: FLOW_JOB, contact_id: "bi-contact-1" },
      { email: "client@bf.test", event: "open" },
    ]);
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit & { headers: Record<string, string> }];
    expect(url).toBe("https://bi.example.test/api/v1/bi/webhooks/sendgrid");
    expect(String(init.body)).toBe(body);
    expect(init.headers["X-Twilio-Email-Event-Webhook-Signature"]).toBe(signature);
    expect(init.headers["X-Twilio-Email-Event-Webhook-Timestamp"]).toBe(ts);
    // BF_SERVER_BI_SENDGRID_FORWARD_AUTH_v1
    expect(init.headers["X-Boreal-Forward-Signature"]).toBe(crypto.createHmac("sha256", "jwt-secret-for-tests").update(`${ts}.${body}`).digest("hex"));
    const timeline = callsMatching(queryMock, TIMELINE);
    expect(timeline).toHaveLength(1); // only the BF event
    expect((timeline[0]![1] as unknown[])[0]).toBe("c-bf");
  });

  // BF_SERVER_UNIVERSAL_SUPPRESSION_v1 - one do-not-email list: a Boreal Risk Management unsubscribe is remembered here
  // too (suppression list + opt-out), but nothing else about the event is written on the Boreal side.
  // BF_SERVER_BRAND_UNSUBSCRIBES_v1 - a BI unsubscribe does not stop Boreal Financial mail; a BI hard bounce does.
  it("forwards bi_mkt events and never opts a Boreal contact out on a BI unsubscribe", async () => {
    await post([{ email: "x@y.test", event: "unsubscribe", bi_mkt: "1" }]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(callsMatching(queryMock, /INSERT INTO email_suppressions/)).toHaveLength(0);
    expect(callsMatching(queryMock, /marketing_opt_out = true/)).toHaveLength(0);
  });

  it("remembers a BI hard bounce on the shared do-not-email list", async () => {
    await post([{ email: "x@y.test", event: "bounce", type: "bounce", bi_mkt: "1" }]);
    expect(callsMatching(queryMock, /INSERT INTO email_suppressions/)[0]![1]).toEqual(["x@y.test", "bounce", "sendgrid_brm"]);
    expect(callsMatching(queryMock, /marketing_opt_out = true/)).toHaveLength(1);
    expect(callsMatching(queryMock, /SELECT id FROM contacts/)).toHaveLength(0);
  });

  it("ignores a Keystone test send's unsubscribe and an open from another sender", async () => {
    await post([{ email: "t@y.test", event: "unsubscribe", ks_mkt_test: "1" }, { email: "o@y.test", event: "open", bi_mkt: "1" }]);
    expect(callsMatching(queryMock, /INSERT INTO email_suppressions/)).toHaveLength(0);
  });

  it("does not call BI-Server for a batch with no BI events", async () => {
    await post([{ email: "client@bf.test", event: "click", url: "https://boreal.financial" }]);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
