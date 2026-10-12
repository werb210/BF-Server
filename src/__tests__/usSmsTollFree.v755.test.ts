// BF_SERVER_US_SMS_TOLLFREE_v755
import { describe, it, expect, afterEach, vi } from "vitest";
import { isUsNumber, smsFromFor, DEFAULT_US_SMS_FROM } from "../lib/smsFrom.js";
import { BULK, LOCAL_FROM, TRANSACTIONAL, driveSender } from "./helpers/smsSenderDrivers.js";

const { queryMock, createMock } = vi.hoisted(() => ({ queryMock: vi.fn(), createMock: vi.fn() }));
vi.mock("../db.js", async () => {
  const actual = await vi.importActual<typeof import("../db.js")>("../db.js");
  return { ...actual, pool: { query: queryMock }, runQuery: queryMock };
});
vi.mock("../lib/sharedClients.js", () => ({ sharedTwilio: () => ({ messages: { create: createMock } }), sharedOpenAI: () => ({}) }));
vi.mock("../services/twilio.js", () => ({ fetchTwilioClient: () => ({ messages: { create: createMock } }) }));
vi.mock("twilio", () => ({ default: () => ({ messages: { create: createMock } }) }));
vi.mock("../services/push/applicantPush.js", () => ({ notifyApplicant: vi.fn(async () => undefined) }));
vi.mock("../modules/automation/automationEngine.js", () => ({ emitAutomationEvent: vi.fn(async () => undefined) }));
vi.mock("../services/lenderMatchCache.js", () => ({
  markLenderMatchesStale: vi.fn(async () => undefined),
  computeAndCacheLenderMatches: vi.fn(async () => undefined),
  getOutstandingRequiredDocs: vi.fn(async () => []),
}));

const LOCAL = "+18254511768";
const US_TO = "+19173043342";
const CA_TO = "+15874441234";

describe("texts to US numbers go out from the toll-free line", () => {
  afterEach(() => { delete process.env.TWILIO_US_SMS_FROM; });
  it("tells US numbers from Canadian and Caribbean ones", () => {
    expect(isUsNumber("+19173043342")).toBe(true);  // New York (Brandon Voss)
    expect(isUsNumber("+18184157968")).toBe(true);  // Los Angeles
    expect(isUsNumber("(212) 555-0100")).toBe(true);
    expect(isUsNumber("+17873000000")).toBe(true);  // Puerto Rico is US
    expect(isUsNumber("+15875550123")).toBe(false); // Calgary
    expect(isUsNumber("+14165550100")).toBe(false); // Toronto
    expect(isUsNumber("+18765550100")).toBe(false); // Jamaica
    expect(isUsNumber("+447700900000")).toBe(false);
    expect(isUsNumber("")).toBe(false);
  });
  it("uses the 866 for US recipients and the local number for everyone else", () => {
    expect(DEFAULT_US_SMS_FROM).toBe("+18666318939");
    expect(smsFromFor("+19173043342", LOCAL)).toBe("+18666318939");
    expect(smsFromFor("+15875550123", LOCAL)).toBe(LOCAL);
  });
  it("can be pointed elsewhere or switched off without code", () => {
    process.env.TWILIO_US_SMS_FROM = "+18005550199";
    expect(smsFromFor("+19173043342", LOCAL)).toBe("+18005550199");
    process.env.TWILIO_US_SMS_FROM = "off";
    expect(smsFromFor("+19173043342", LOCAL)).toBe(LOCAL);
  });

  it.each(TRANSACTIONAL)("%s sends a US text from the 866 and a Canadian one from the local number", async (name) => {
    const us = await driveSender(name, US_TO, { queryMock, createMock });
    expect(us.error).toBeUndefined();
    expect(us.payload, `${name} reached Twilio`).toBeDefined();
    expect(us.payload!.from).toBe(DEFAULT_US_SMS_FROM);
    expect(us.payload!.to).toBe(US_TO);
    const ca = await driveSender(name, CA_TO, { queryMock, createMock });
    expect(ca.payload!.from).toBe(LOCAL_FROM);
  });

  it.each(BULK)("%s is kept off the toll-free line", async (name) => {
    const us = await driveSender(name, US_TO, { queryMock, createMock });
    expect(us.payload, `${name} reached Twilio`).toBeDefined();
    expect(us.payload!.from).toBe(LOCAL_FROM);
  });
});
