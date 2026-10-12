// BF_SERVER_CONFERENCE_SINGLE_SOURCE_v1 - there were two conferenceService.ts
// files. src/voice/conferenceService.ts is the live one (every conference route
// imports it); src/telephony/services/conferenceService.ts was imported by
// nothing. Dead duplicates have repeatedly caused wasted work, so this test
// keeps the tree honest: exactly one conference service, and it is the live one.
import { describe, it, expect, vi } from "vitest";
import { existsSync } from "node:fs";
import { join } from "node:path";
import express from "express";
import request from "supertest";
import twilio from "twilio";
import { answerBySql, callsMatching } from "../../__tests__/helpers/answerBySql.js";

const h = vi.hoisted(() => ({
  query: vi.fn(),
  getConferenceByFriendly: vi.fn(async () => ({ id: "conf-1", twilio_conference_sid: "CF1" })),
}));
vi.mock("twilio", async () => await vi.importActual<typeof import("twilio")>("twilio"));
vi.mock("../../db", async () => {
  const actual = await vi.importActual<typeof import("../../db.js")>("../../db");
  return { ...actual, pool: { query: h.query }, runQuery: h.query, dbQuery: h.query, query: h.query };
});
// The live service. If the routes imported any other copy, this mock would never be reached.
vi.mock("../../voice/conferenceService.js", async (orig) => ({
  ...(await orig<typeof import("../../voice/conferenceService.js")>()),
  getConferenceByFriendly: h.getConferenceByFriendly,
  notifyConferenceState: vi.fn(async () => undefined),
}));

describe("BF_SERVER_CONFERENCE_SINGLE_SOURCE_v1", () => {
  it("keeps the live conference service", () => {
    expect(existsSync(join(process.cwd(), "src/voice/conferenceService.ts"))).toBe(true);
  });

  it("does not resurrect the dead telephony duplicate", () => {
    expect(existsSync(join(process.cwd(), "src/telephony/services/conferenceService.ts"))).toBe(false);
  });

  it("routes still use the live service", async () => {
    h.query.mockImplementation(answerBySql([]));
    const { default: conferenceWebhooks } = await import("../conferenceWebhooks.js");
    const app = express();
    app.use("/api/webhooks/twilio", conferenceWebhooks);
    const path = "/api/webhooks/twilio/conference/status?conf=bf-conf-1";
    const params = { StatusCallbackEvent: "conference-start", ConferenceSid: "CF1", CallSid: "CA1" };
    const res = await request(app).post(path).type("form")
      .set("X-Forwarded-Host", "example.com").set("X-Forwarded-Proto", "https")
      .set("X-Twilio-Signature", twilio.getExpectedTwilioSignature(String(process.env.TWILIO_AUTH_TOKEN), `https://example.com${path}`, params))
      .send(params);
    expect(res.status).toBe(200);
    expect(h.getConferenceByFriendly).toHaveBeenCalledWith("bf-conf-1");
    expect(callsMatching(h.query, /UPDATE conferences SET status = 'active'/).map((c) => c[1])).toEqual([["conf-1"]]);
  });
});
