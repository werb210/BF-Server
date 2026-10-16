// BF_SERVER_v817_IPAD_VOIP - POST /api/voice/token can mint a token for the staff portal iPad app, whose VoIP pushes
// use their own Twilio Push Credential (TWILIO_PUSH_CREDENTIAL_SID_PORTAL, bundle com.borealfinancial.portal).
import express from "express";
import jwt from "jsonwebtoken";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { answerBySql, callsMatching } from "../../__tests__/helpers/answerBySql.js";

const h = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("../../db.js", async () => {
  const actual = await vi.importActual<typeof import("../../db.js")>("../../db.js");
  const q = (...a: unknown[]) => h.query(...a);
  return { ...actual, pool: { query: q }, dbQuery: q, runQuery: q };
});
vi.mock("../../config/index.js", async () => {
  const actual = await vi.importActual<any>("../../config/index.js");
  return {
    ...actual,
    config: {
      ...actual.config,
      twilio: { ...actual.config?.twilio, accountSid: "AC" + "1".repeat(32), apiKey: "SK" + "2".repeat(32), apiSecret: "secret-for-tests", voiceAppSid: "AP" + "3".repeat(32) },
    },
  };
});

const DIALER_CR = "CR" + "a".repeat(32);
const PORTAL_CR = "CR" + "b".repeat(32);
const STAFF_ID = "00000000-0000-4000-8000-0000000008a1";
const staffJwt = () => jwt.sign({ sub: STAFF_ID, id: STAFF_ID, role: "Admin", tokenVersion: 0, tv: 0 }, String(process.env.JWT_SECRET));

async function app() {
  const router = (await import("../../routes/voiceCalls.js")).default;
  const a = express();
  a.use(express.json());
  a.use("/api/voice", router);
  return a;
}
const grantOf = (token: string) => (jwt.decode(token) as any).grants;

beforeEach(() => {
  h.query.mockReset();
  h.query.mockImplementation(answerBySql([]));
  process.env.TWILIO_PUSH_CREDENTIAL_SID = DIALER_CR;
  process.env.TWILIO_PUSH_CREDENTIAL_SID_PORTAL = ` ${PORTAL_CR} `;
});
afterEach(() => {
  delete process.env.TWILIO_PUSH_CREDENTIAL_SID;
  delete process.env.TWILIO_PUSH_CREDENTIAL_SID_PORTAL;
});

describe("voice token per app", () => {
  it("no app (the iPhone dialer) keeps the dialer push credential", async () => {
    const res = await request(await app()).post("/api/voice/token").set("Authorization", `Bearer ${staffJwt()}`).send({});
    expect(res.status).toBe(200);
    const g = grantOf(res.body.token);
    expect(g.identity).toBe(STAFF_ID);
    expect(g.voice.push_credential_sid).toBe(DIALER_CR);
    expect(g.voice.incoming.allow).toBe(true);
  });

  it("app=portal-ios in the body uses TWILIO_PUSH_CREDENTIAL_SID_PORTAL, same identity", async () => {
    const res = await request(await app()).post("/api/voice/token").set("Authorization", `Bearer ${staffJwt()}`).send({ app: "portal-ios" });
    expect(res.status).toBe(200);
    const g = grantOf(res.body.token);
    expect(g.identity).toBe(STAFF_ID);
    expect(g.voice.push_credential_sid).toBe(PORTAL_CR);
    expect(g.voice.outgoing.application_sid).toBe("AP" + "3".repeat(32));
    // The iPad registers the same identity in staff_presence, so the IVR's <Client> dial rings it too.
    const [up] = callsMatching(h.query, /INSERT INTO staff_presence/);
    expect(up[1]).toEqual([STAFF_ID, STAFF_ID]);
  });

  it("app=portal-ios in the query string, the X-Boreal-App header, or the portal_ipad alias works too", async () => {
    let res = await request(await app()).post("/api/voice/token?app=portal-ios").set("Authorization", `Bearer ${staffJwt()}`).send({});
    expect(grantOf(res.body.token).voice.push_credential_sid).toBe(PORTAL_CR);
    res = await request(await app()).post("/api/voice/token").set("Authorization", `Bearer ${staffJwt()}`).set("X-Boreal-App", "portal-ios").send({});
    expect(grantOf(res.body.token).voice.push_credential_sid).toBe(PORTAL_CR);
    expect(grantOf(res.body.token).identity).toBe(STAFF_ID);
    res = await request(await app()).post("/api/voice/token").set("Authorization", `Bearer ${staffJwt()}`).send({ app: "portal_ipad" });
    expect(grantOf(res.body.token).voice.push_credential_sid).toBe(PORTAL_CR);
  });

  it("portal-ios without (or with a malformed) portal credential has no push credential", async () => {
    process.env.TWILIO_PUSH_CREDENTIAL_SID_PORTAL = "not-a-sid";
    let res = await request(await app()).post("/api/voice/token").set("Authorization", `Bearer ${staffJwt()}`).send({ app: "portal-ios" });
    expect(grantOf(res.body.token).voice.push_credential_sid).toBeUndefined();
    delete process.env.TWILIO_PUSH_CREDENTIAL_SID_PORTAL;
    res = await request(await app()).post("/api/voice/token").set("Authorization", `Bearer ${staffJwt()}`).send({ app: "portal_ipad" });
    expect(grantOf(res.body.token).voice.push_credential_sid).toBeUndefined();
  });

  it("parseVoiceTokenApp: unknown values fall back to the dialer", async () => {
    const { parseVoiceTokenApp, pushCredentialGrant } = await import("../services/tokenService.js");
    expect(parseVoiceTokenApp("portal-ios")).toBe("portal-ios");
    expect(parseVoiceTokenApp(" PORTAL-IOS ")).toBe("portal-ios");
    expect(parseVoiceTokenApp("portal_ipad")).toBe("portal-ios");
    expect(parseVoiceTokenApp(undefined)).toBe("dialer");
    expect(parseVoiceTokenApp("watch")).toBe("dialer");
    expect(pushCredentialGrant({ TWILIO_PUSH_CREDENTIAL_SID: DIALER_CR } as any, "portal-ios")).toEqual({});
  });
});
