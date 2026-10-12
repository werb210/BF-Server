// BF_SERVER_SMS_LOOP_KILL_v121
import { beforeEach, describe, expect, it, vi } from "vitest";
import { answerBySql, callsMatching } from "../../__tests__/helpers/answerBySql.js";

const h = vi.hoisted(() => ({ queryMock: vi.fn(), workerSend: vi.fn(), create: vi.fn(), pushDeadLetter: vi.fn() }));
vi.mock("../../db.js", async (orig) => ({ ...(await orig<typeof import("../../db.js")>()), pool: { query: h.queryMock } }));
// The worker is tested against a spy; the service itself is loaded with vi.importActual below.
vi.mock("../../modules/notifications/sms.service.js", async (orig) => ({ ...(await orig<typeof import("../../modules/notifications/sms.service.js")>()), sendSms: h.workerSend }));
vi.mock("../../services/twilio.js", () => ({ fetchTwilioClient: () => ({ messages: { create: h.create } }) }));
vi.mock("../../lib/deadLetter.js", () => ({ pushDeadLetter: h.pushDeadLetter }));
vi.mock("../../config/index.js", async (orig) => {
  const real = await orig<typeof import("../../config/index.js")>();
  return { ...real, config: { ...real.config, app: { ...real.config.app, testMode: "false" }, twilio: { ...real.config.twilio, from: "+18254511768" } } };
});

import { isPermanentSmsFailure, isUndeliverableNumber, twilioErrorCode } from "../smsDeliverability.js";
import { processDeadLetters } from "../../workers/deadLetterWorker.js";
import { loadSheetRowData } from "../../modules/submissions/merchantGrowthSheet.js";

const realSms = () => vi.importActual<typeof import("../../modules/notifications/sms.service.js")>("../../modules/notifications/sms.service.js");
const permanent = () => Object.assign(new Error("The 'To' number is not a valid phone number."), { code: 21211 });
let jobs: Array<{ id: string; retry_count: number; type: string; data: any }>;

beforeEach(() => {
  jobs = [];
  h.workerSend.mockReset();
  h.workerSend.mockResolvedValue({ sid: "SM1" });
  h.create.mockReset();
  h.pushDeadLetter.mockReset();
  h.pushDeadLetter.mockResolvedValue(undefined);
  h.queryMock.mockReset();
  h.queryMock.mockImplementation(answerBySql([
    [/SELECT \* FROM failed_jobs/, () => ({ rows: jobs })],
  ]));
});

describe("undeliverable SMS numbers", () => {
  it.each(["+15555555555", "(555) 555-5555", "+11234567891"])("rejects %s", (number) => {
    expect(isUndeliverableNumber(number)).toBe(true);
  });

  it("rejects short, empty, and identical-digit numbers", () => {
    for (const number of ["", "12345", "0000000000", "1111111111", null, undefined]) {
      expect(isUndeliverableNumber(number)).toBe(true);
    }
  });

  it("accepts plausible real numbers", () => {
    for (const number of ["+18254511768", "8254511768", "1-306-209-9483", "778.989.5508", "+14034211234"]) {
      expect(isUndeliverableNumber(number)).toBe(false);
    }
  });
});

describe("permanent SMS failures", () => {
  it.each([21602, 21211, 21214, 21408, 21610, 21612, 21614, 30003, 30005, 30006])("recognizes code %i", (code) => {
    expect(isPermanentSmsFailure({ code })).toBe(true);
  });

  it("does not classify transient errors as permanent", () => {
    for (const code of [20429, 500, 0]) expect(isPermanentSmsFailure({ code })).toBe(false);
  });

  it("reads either code or status", () => {
    expect(twilioErrorCode({ status: 21211 })).toBe(21211);
    expect(twilioErrorCode(new Error("boom"))).toBe(0);
  });
});

describe("the payload shape mismatch that caused it", () => {
  it("the worker maps the stored `body` onto sendSms's `message`", async () => {
    // The dead letter stores the Twilio payload, whose text is under `body`.
    jobs = [{ id: "j1", retry_count: 0, type: "sms", data: { to: "+18254511768", body: "Your documents are ready", from: "+1999", statusCallback: "x" } }];
    await processDeadLetters();
    expect(h.workerSend).toHaveBeenCalledTimes(1);
    expect(h.workerSend.mock.calls[0][0]).toEqual({ to: "+18254511768", message: "Your documents are ready" });
    expect(callsMatching(h.queryMock, /DELETE FROM failed_jobs WHERE id = \$1/)[0][1]).toEqual(["j1"]);
  });

  it("does not pass the raw payload through, which sent an empty body", async () => {
    jobs = [{ id: "j2", retry_count: 0, type: "sms", data: { to: "+18254511768", message: "legacy shape" } }];
    await processDeadLetters();
    const arg = h.workerSend.mock.calls[0][0];
    expect(arg).not.toBe(jobs[0].data);
    expect(arg).toEqual({ to: "+18254511768", message: "legacy shape" });
  });
});

describe("dead-letter cycle prevention", () => {
  it("disables enqueueing from the worker", async () => {
    jobs = [{ id: "j3", retry_count: 0, type: "sms", data: { to: "+18254511768", body: "hi" } }];
    await processDeadLetters();
    expect(h.workerSend.mock.calls[0][1]).toEqual({ enqueueOnFailure: false });
  });

  it("does not wrap processJob in withRetry", async () => {
    // A transient failure is tried once per tick and counted, not retried in a loop.
    jobs = [{ id: "j4", retry_count: 2, type: "sms", data: { to: "+18254511768", body: "hi" } }];
    h.workerSend.mockRejectedValue(Object.assign(new Error("Too many requests"), { code: 20429 }));
    await processDeadLetters();
    expect(h.workerSend).toHaveBeenCalledTimes(1);
    expect(callsMatching(h.queryMock, /SET retry_count = retry_count \+ 1/)[0][1]).toEqual(["j4"]);
    // A permanent failure retires the job at once.
    h.workerSend.mockReset();
    h.workerSend.mockRejectedValue(permanent());
    h.queryMock.mockClear();
    await processDeadLetters();
    expect(callsMatching(h.queryMock, /SET retry_count = \$2/)[0][1]).toEqual(["j4", 10]);
  });

  it("conditionally enqueues failures", async () => {
    const { sendSms } = await realSms();
    h.create.mockRejectedValue(permanent());
    await expect(sendSms({ to: "+18254511768", message: "hi" }, { enqueueOnFailure: false })).rejects.toThrow();
    expect(h.pushDeadLetter).not.toHaveBeenCalled();
    await expect(sendSms({ to: "+18254511768", message: "hi" })).rejects.toThrow();
    expect(h.pushDeadLetter).toHaveBeenCalledTimes(1);
    expect(h.pushDeadLetter.mock.calls[0][0]).toMatchObject({ type: "sms", data: { to: "+18254511768", body: "hi" } });
  });

  it("guards before the Twilio call", async () => {
    const { sendSms, UndeliverableNumberError } = await realSms();
    await expect(sendSms({ to: "+15555555555", message: "hi" })).rejects.toBeInstanceOf(UndeliverableNumberError);
    expect(h.create).not.toHaveBeenCalled();
    expect(h.pushDeadLetter).not.toHaveBeenCalled();
  });

  it("retires invalid queued destinations", async () => {
    jobs = [{ id: "j5", retry_count: 0, type: "sms", data: { to: "+15555555555", body: "hi" } }];
    await processDeadLetters();
    expect(h.workerSend).not.toHaveBeenCalled();
    expect(callsMatching(h.queryMock, /UPDATE failed_jobs SET retry_count = \$2 WHERE id = \$1/)[0][1]).toEqual(["j5", 10]);
  });
});

describe("mobile field", () => {
  const sheetPool = (row: Record<string, unknown>) => ({ query: async () => ({ rows: [row] }) }) as any;

  it("does not fall back to the business phone", async () => {
    const d = await loadSheetRowData(sheetPool({ phone: null, metadata: { business: { phone: "403-555-0100" }, applicant: {} } }), "app-1");
    expect(d.mobile).toBe("");
    expect(d.phone).toBe("4035550100");
    const fromContact = await loadSheetRowData(sheetPool({ phone: "+1 780 555 0199", metadata: { business: { phone: "403-555-0100" }, applicant: {} } }), "app-1");
    expect(fromContact.mobile).toBe("7805550199");
  });

  it("keeps the business number in the phone field", async () => {
    const d = await loadSheetRowData(sheetPool({ phone: "7805550199", metadata: { business: { phone: "4035550100" }, applicant: { phone: "5875550123" } } }), "app-1");
    expect(d.mobile).toBe("5875550123");
    expect(d.phone).toBe("4035550100");
    const noBusiness = await loadSheetRowData(sheetPool({ phone: "7805550199", metadata: { business: {}, applicant: { phone: "5875550123" } } }), "app-1");
    expect(noBusiness.phone).toBe("5875550123");
  });
});
