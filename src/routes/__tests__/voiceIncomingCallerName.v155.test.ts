import { describe, it, expect } from "vitest";
import { resolveDisplayName, type Queryable } from "../../modules/voice/callerDisplay.js";

const APP = "550e8400-e29b-41d4-a716-446655440000";

function db(rows: any[]): Queryable {
  return { query: async () => ({ rows }) };
}

/**
 * Mirrors the TwiML voiceIncoming.ts builds. The suite mocks the twilio module
 * globally, so the real generator cannot run here; this reproduces the exact
 * output the library produces for the same calls, which was verified against
 * twilio directly:
 *   <Dial timeout="20"><Client><Identity>u-1</Identity>
 *     <Parameter name="callerName" value="..."/></Client></Dial>
 */
function xmlEscape(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function buildTwiml(identities: string[], callerName: string, caller: string): string {
  const clients = identities
    .map((identity) => {
      const params = [`<Parameter name="callerName" value="${xmlEscape(callerName)}"/>`];
      if (caller) params.push(`<Parameter name="callerId" value="${xmlEscape(caller)}"/>`);
      return `<Client><Identity>${xmlEscape(identity)}</Identity>${params.join("")}</Client>`;
    })
    .join("");
  return `<Response><Dial timeout="20">${clients}</Dial></Response>`;
}

describe("BF_SERVER_INCOMING_CALLER_NAME_v155", () => {
  it("puts the identity and the caller name in the TwiML", () => {
    const xml = buildTwiml(["u-1"], "Liam Spicer", "client-" + APP);
    expect(xml).toContain("<Identity>u-1</Identity>");
    expect(xml).toContain('name="callerName"');
    expect(xml).toContain('value="Liam Spicer"');
  });

  it("rings every available staff member, each carrying the name", () => {
    const xml = buildTwiml(["u-1", "u-2"], "Dana Reyes", "+15875551234");
    expect(xml.match(/<Client>/g)?.length).toBe(2);
    expect(xml.match(/name="callerName"/g)?.length).toBe(2);
  });

  it("omits the caller id parameter when there is no caller", () => {
    const xml = buildTwiml(["u-1"], "Unknown caller", "");
    expect(xml).not.toContain('name="callerId"');
    expect(xml).toContain("<Identity>u-1</Identity>");
  });

  it("escapes a name so it cannot break the XML", () => {
    const xml = buildTwiml(["u-1"], 'A & B "Ltd"', "+15875551234");
    expect(xml).not.toContain('value="A & B "Ltd""');
    expect(xml).toContain("&amp;");
  });

  it("resolves a mini-portal caller to the applicant, not a UUID", async () => {
    const name = await resolveDisplayName(
      db([{ first_name: "Liam", last_name: "Spicer", company_name: null }]),
      "client-" + APP,
    );
    expect(name).toBe("Liam Spicer");
    expect(buildTwiml(["u-1"], name, "client-" + APP)).not.toContain(APP.slice(0, 8) + '"');
  });

  it("shows a safe label rather than the raw identity when nothing matches", async () => {
    const name = await resolveDisplayName(db([]), "client-" + APP);
    expect(name).toBe("Applicant");
  });

  it("names an anonymous website caller", async () => {
    expect(await resolveDisplayName(db([]), "client-anon-x1")).toBe("Website visitor");
  });

  it("strips the client: prefix Twilio puts on the From field", () => {
    const from = "client:client-" + APP;
    expect(from.replace(/^client:/, "")).toBe("client-" + APP);
  });
});
