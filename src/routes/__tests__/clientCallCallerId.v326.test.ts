// BF_SERVER_CLIENT_CALL_CALLER_ID_v326
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const webhooks = readFileSync(resolve(__dirname, "..", "webhooks.ts"), "utf-8");
const voiceCalls = readFileSync(resolve(__dirname, "..", "voiceCalls.ts"), "utf-8");

describe("a Call Us! caller reaches staff with a name", () => {
  it("rings staff from the applicant's own number", () => {
    const branch = webhooks.slice(webhooks.indexOf('if (from.startsWith("client:client-"))'));
    const ring = branch.slice(0, branch.indexOf("PSTN inbound"));
    expect(ring).toContain("fromNumber: clientPhone,");
  });

  it("resolves the applicant and broadcasts a resolvable caller", () => {
    expect(webhooks).toContain('/^client-([0-9a-f-]{36})$/i.exec(clientIdentity)');
    expect(webhooks).toContain("LEFT JOIN contacts c ON c.id = a.contact_id");
    expect(webhooks).toContain("broadcastIncomingRing(conf.id, clientPhone || from)");
    expect(voiceCalls).toContain("BF_SERVER_CLIENT_APP_CALLER_v1");
  });

  it("carries the business name and logs resolution", () => {
    expect(voiceCalls).toContain('companyName: String(hit.business_name ?? "").trim() || null,');
    expect(webhooks).toContain('event: "client_miniportal_caller_resolved"');
  });
});

describe("an unusable number is never sent to Twilio", () => {
  const callerNumberOrEmpty = (raw: unknown): string => {
    const digits = String(raw ?? "").replace(/[^0-9]/g, "");
    if (digits.length === 10) return `+1${digits}`;
    if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
    if (digits.length >= 11 && digits.length <= 15) return `+${digits}`;
    return "";
  };

  it.each([
    ["(825) 451-1768", "+18254511768"],
    ["8254511768", "+18254511768"],
    ["+1 825 451 1768", "+18254511768"],
    ["", ""],
    [null, ""],
    ["not a phone", ""],
    ["12345", ""],
  ])("%s -> %s", (input, expected) => {
    expect(callerNumberOrEmpty(input)).toBe(expected);
  });
});
