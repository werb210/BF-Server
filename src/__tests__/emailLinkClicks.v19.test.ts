// BF_SERVER_EMAIL_LINK_CLICKS_v19 - which links people actually clicked.
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";
import { answerBySql, callsMatching } from "./helpers/answerBySql.js";

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));
vi.mock("../db.js", async (orig) => {
  const real: any = await orig();
  const pool = { query: queryMock, connect: vi.fn() };
  return { ...real, pool, db: pool };
});
vi.mock("../modules/automation/automationEngine.js", () => ({ emitAutomationEvent: vi.fn() }));

import marketing from "../routes/marketing.js";
import sendgridWebhook from "../routes/sendgridWebhook.js";
import { loadCrmTimeline } from "../routes/crm/timeline.js";

const migration = fs.readFileSync(path.resolve(__dirname, "../../migrations/2026_08_05_email_link_clicks.sql"), "utf8");

const app = express();
app.use("/api/webhooks/sendgrid", sendgridWebhook);
app.use(express.json());
app.use("/api/marketing", marketing);
const token = jwt.sign({ sub: "11111111-1111-4111-8111-111111111111", role: "Admin", tokenVersion: 0, tv: 0 }, process.env.JWT_SECRET!, { expiresIn: "5m" });
const get = (url: string, silo = "BF") => request(app).get(url).set("Authorization", `Bearer ${token}`).set("X-Silo", silo);

// A real ECDSA key pair, so the webhook's signature check passes for real.
const { publicKey, privateKey } = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const pubB64 = publicKey.export({ type: "spki", format: "der" }).toString("base64");
function postEvents(events: unknown[]) {
  const body = JSON.stringify(events);
  const ts = String(Math.floor(Date.now() / 1000));
  const signature = crypto.createSign("sha256").update(ts + body).sign(privateKey, "base64");
  return request(app).post("/api/webhooks/sendgrid").set("Content-Type", "application/json")
    .set("X-Twilio-Email-Event-Webhook-Signature", signature).set("X-Twilio-Email-Event-Webhook-Timestamp", ts).send(body);
}

const prevKey = process.env.SENDGRID_WEBHOOK_PUBLIC_KEY;
let logSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  process.env.SENDGRID_WEBHOOK_PUBLIC_KEY = pubB64;
  logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  queryMock.mockReset();
  queryMock.mockImplementation(answerBySql([
    [/SELECT template_id, silo FROM template_send_events/, { rows: [{ template_id: "tpl-1", silo: "BI" }] }],
    [/FROM email_link_clicks/, { rows: [{ url: "https://boreal.financial/apply", clicks: 5, contacts: 3, last_clicked: "2026-10-01" }] }],
  ]));
});
afterEach(() => {
  logSpy.mockRestore();
  if (prevKey === undefined) delete process.env.SENDGRID_WEBHOOK_PUBLIC_KEY;
  else process.env.SENDGRID_WEBHOOK_PUBLIC_KEY = prevKey;
});

describe("email link click capture", () => {
  it("creates the ledger idempotently with no foreign keys", () => {
    expect(migration).toContain("CREATE TABLE IF NOT EXISTS email_link_clicks");
    expect(migration).not.toMatch(/REFERENCES/i);
  });

  it("writes the clicked URL onto the timeline payload", async () => {
    const r = await postEvents([{ event: "click", contact_id: "c1", email: "a@x.test", url: "https://boreal.financial/apply" }]);
    expect(r.status).toBe(200);
    const [, params] = callsMatching(queryMock, /INSERT INTO crm_timeline_events/)[0] as [string, unknown[]];
    expect(params[0]).toBe("c1");
    expect(params[1]).toBe("email_click");
    expect(JSON.parse(String(params[2])).url).toBe("https://boreal.financial/apply");
  });

  it("the timeline renders that payload key as the row body for a click", async () => {
    await loadCrmTimeline(true, "c1", "BF");
    const sql = String(queryMock.mock.calls.at(-1)![0]);
    expect(sql).toContain("ELSE NULLIF(payload->>'url','') END) AS body");
    expect(sql).toContain("'email_click'");
  });

  it("records one ledger row per click, attributed to the template's silo", async () => {
    await postEvents([
      { event: "click", contact_id: "c1", url: "https://boreal.financial/apply", tse_id: "tse-9" },
      { event: "click", contact_id: "c2", url: "https://boreal.financial/rates" },
      { event: "open", contact_id: "c3" },
    ]);
    const rows = callsMatching(queryMock, /INSERT INTO email_link_clicks \(contact_id, template_id, tse_id, silo, url\)/).map((c) => c[1]);
    expect(rows).toEqual([
      ["c1", "tpl-1", "tse-9", "BI", "https://boreal.financial/apply"],
      ["c2", null, null, "BF", "https://boreal.financial/rates"],
    ]);
  });

  it("never lets click tracking break event ingestion", async () => {
    queryMock.mockImplementation(answerBySql([[/INSERT INTO email_link_clicks/, new Error("ledger down")]]));
    const r = await postEvents([
      { event: "click", contact_id: "c1", url: "https://boreal.financial/apply" },
      { event: "unsubscribe", contact_id: "c2" },
    ]);
    expect(r.status).toBe(200);
    // The next event in the batch is still processed.
    expect(callsMatching(queryMock, /UPDATE contacts SET marketing_opt_out = true/)[0][1]).toEqual(["c2"]);
  });

  it("exposes a per-URL rollup, optionally for one template", async () => {
    const r = await get("/api/marketing/link-clicks?templateId=tpl-1&days=30", "BI");
    expect(r.status).toBe(200);
    expect(r.body.data).toEqual({ items: [{ url: "https://boreal.financial/apply", clicks: 5, contacts: 3, last_clicked: "2026-10-01" }], days: 30, templateId: "tpl-1" });
    const [sql, params] = callsMatching(queryMock, /FROM email_link_clicks/)[0] as [string, unknown[]];
    expect(params).toEqual(["BI", 30, "tpl-1"]);
    expect(sql).toContain("AND template_id = $3");
    expect(sql).toContain("count(DISTINCT contact_id)::int AS contacts");
    // node-postgres returns bigint as a string, so counts are cast to int.
    expect(sql).toContain("count(*)::int AS clicks");
  });

  it("exposes the contacts who clicked one URL", async () => {
    const r = await get("/api/marketing/link-clicks/contacts?url=https%3A%2F%2Fboreal.financial%2Fapply");
    expect(r.status).toBe(200);
    const [sql, params] = callsMatching(queryMock, /FROM email_link_clicks e/)[0] as [string, unknown[]];
    expect(params).toEqual(["BF", "https://boreal.financial/apply", 90]);
    expect(sql).toContain("count(*)::int AS clicks");
  });

  it("the contact list needs a URL", async () => {
    const r = await get("/api/marketing/link-clicks/contacts");
    expect(r.body.data).toEqual({ items: [] });
    expect(callsMatching(queryMock, /FROM email_link_clicks/)).toHaveLength(0);
  });

  it("both reports require a signed-in user", async () => {
    expect((await request(app).get("/api/marketing/link-clicks")).status).toBe(401);
    expect((await request(app).get("/api/marketing/link-clicks/contacts?url=x")).status).toBe(401);
  });
});
