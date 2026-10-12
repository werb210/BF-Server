// BF_SERVER_GUARD_EVERYWHERE_v136
import { describe, it, expect, vi } from "vitest";
import { isUndeliverableNumber } from "../smsDeliverability.js";
import { driveSender, type SenderName } from "../../__tests__/helpers/smsSenderDrivers.js";

const { queryMock, createMock } = vi.hoisted(() => ({ queryMock: vi.fn(), createMock: vi.fn() }));
vi.mock("../../db.js", async () => {
  const actual = await vi.importActual<typeof import("../../db.js")>("../../db.js");
  return { ...actual, pool: { query: queryMock }, runQuery: queryMock };
});
vi.mock("../sharedClients.js", () => ({ sharedTwilio: () => ({ messages: { create: createMock } }), sharedOpenAI: () => ({}) }));
vi.mock("../../services/twilio.js", () => ({ fetchTwilioClient: () => ({ messages: { create: createMock } }) }));
vi.mock("twilio", () => ({ default: () => ({ messages: { create: createMock } }) }));
vi.mock("../../services/push/applicantPush.js", () => ({ notifyApplicant: vi.fn(async () => undefined) }));
vi.mock("../../modules/automation/automationEngine.js", () => ({ emitAutomationEvent: vi.fn(async () => undefined) }));
vi.mock("../../services/lenderMatchCache.js", () => ({
  markLenderMatchesStale: vi.fn(async () => undefined),
  computeAndCacheLenderMatches: vi.fn(async () => undefined),
  getOutstandingRequiredDocs: vi.fn(async () => []),
}));

const JUNK = "+15555555555";
const GOOD = "+18254511768";
const sites: Array<[string, SenderName]> = [
  ["staff/system SMS", "staff/system SMS"],
  ["marketing blasts", "marketing blasts"],
  ["twilio helper", "twilio helper"],
  ["portal doc rejection", "portal doc rejection"],
  ["staff communications", "staff communications"],
];

describe("SMS deliverability", () => {
  it("conservatively classifies phone numbers", () => {
    expect(isUndeliverableNumber("+13444444953")).toBe(false);
    expect(isUndeliverableNumber("+15555555555")).toBe(true);
    expect(isUndeliverableNumber("+11234567890")).toBe(true);
    expect(isUndeliverableNumber("12345")).toBe(true);
    expect(isUndeliverableNumber("+18254511768")).toBe(false);
  });

  it.each(sites)("%s guards before sending", async (_label, name) => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const junk = await driveSender(name, JUNK, { queryMock, createMock });
    expect(junk.payload, "nothing reaches Twilio for a junk number").toBeUndefined();
    const good = await driveSender(name, GOOD, { queryMock, createMock });
    expect(good.payload, "a real number still goes out").toBeDefined();
    warn.mockRestore();
  });

  it("maps failures to caller-appropriate results", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const marketing = await driveSender("marketing blasts", JUNK, { queryMock, createMock });
    expect(marketing.result).toEqual({ ok: false, error: "undeliverable_number" });

    const system = await driveSender("staff/system SMS", JUNK, { queryMock, createMock });
    expect(system.error).toBeUndefined();
    expect(warn).toHaveBeenCalledWith("[sms] skipped undeliverable number", JUNK.slice(0, 6));

    const staff = await driveSender("staff communications", JUNK, { queryMock, createMock });
    expect(staff.status).toBe(400);
    expect(staff.body).toEqual({ error: "undeliverable_number", message: "That number cannot receive SMS." });

    const helper = await driveSender("twilio helper", JUNK, { queryMock, createMock });
    expect(String((helper.error as Error)?.message)).toMatch(/^undeliverable_number:/);
    warn.mockRestore();
  });
});
