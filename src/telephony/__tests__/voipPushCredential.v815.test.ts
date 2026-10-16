// BF_SERVER_v815_VOIP_PUSH - the dialer's voice token names the Twilio Push Credential when it is configured.
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../config/index.js", () => ({
  config: { twilio: { accountSid: "AC" + "1".repeat(32), apiKey: "SK" + "2".repeat(32), apiSecret: "secret-for-tests", voiceAppSid: "AP" + "3".repeat(32) } },
}));
import jwt from "jsonwebtoken";
import { generateVoiceToken, pushCredentialGrant } from "../services/tokenService.js";

const CR = "CR" + "a".repeat(32);
afterEach(() => { delete process.env.TWILIO_PUSH_CREDENTIAL_SID; });
const voiceGrant = () => (jwt.decode(generateVoiceToken("staff:u1")) as any).grants.voice;

describe("VoIP push credential in the voice token", () => {
  it("is added when TWILIO_PUSH_CREDENTIAL_SID is a CR sid", () => {
    process.env.TWILIO_PUSH_CREDENTIAL_SID = ` ${CR} `;
    const g = voiceGrant();
    expect(g.push_credential_sid).toBe(CR);
    expect(g.incoming.allow).toBe(true);
    expect(g.outgoing.application_sid).toBe("AP" + "3".repeat(32));
  });
  it("token is unchanged when unset or malformed", () => {
    expect(voiceGrant().push_credential_sid).toBeUndefined();
    process.env.TWILIO_PUSH_CREDENTIAL_SID = "not-a-sid";
    expect(voiceGrant().push_credential_sid).toBeUndefined();
    expect(pushCredentialGrant({ TWILIO_PUSH_CREDENTIAL_SID: "" } as any)).toEqual({});
  });
});
