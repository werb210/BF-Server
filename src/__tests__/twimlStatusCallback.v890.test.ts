// BF_SERVER_v890_TWIML_STATUS_CALLBACK - a status callback that lands on the TwiML URL is recorded, not treated as a new call.
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { answerBySql } from "./helpers/answerBySql.js";
import { mountRouter } from "./helpers/staffRouterApp.js";

const h = vi.hoisted(() => ({ query: vi.fn(), status: vi.fn() }));
vi.mock("../db.js", async () => ({ ...(await vi.importActual<any>("../db.js")), pool: { query: h.query }, dbQuery: h.query, runQuery: h.query }));
vi.mock("../middleware/twilioWebhookValidation.js", () => {
  const pass = (_req: unknown, _res: unknown, next: () => void) => next();
  return { twilioWebhookValidation: pass, validateTwilioWebhook: pass };
});
vi.mock("../modules/voice/voice.service.js", async () => ({
  ...(await vi.importActual<any>("../modules/voice/voice.service.js")),
  handleVoiceStatusWebhook: h.status,
}));

beforeEach(() => {
  h.query.mockReset(); h.query.mockImplementation(answerBySql([]));
  h.status.mockReset(); h.status.mockResolvedValue(undefined);
  vi.spyOn(console, "log").mockImplementation(() => undefined);
});

describe("status callback on the TwiML URL", () => {
  it("records the final status and does not speak", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const app = mountRouter((await import("../routes/webhooks.js")).default, "/api/webhooks");
    const res = await request(app).post("/api/webhooks/twilio/voice/twiml").type("form").send({
      From: "client:00000000-0000-0000-0000-000000000099", To: "", CallSid: "CA-status", CallStatus: "completed",
      CallDuration: "5", Duration: "1", CallbackSource: "call-progress-events", SequenceNumber: "0",
    });
    expect(res.status).toBe(200);
    expect(res.text).not.toContain("There is no number to call.");
    expect(res.text).toContain("<Response/>");
    expect(h.status).toHaveBeenCalledWith(expect.objectContaining({ callSid: "CA-status", callStatus: "completed", callDuration: "5" }));
    expect(warn.mock.calls.map((c) => String(c[0])).some((l) => l.includes("staff_call_without_number"))).toBe(false);
    warn.mockRestore();
  });

  it("still answers a real call with no number", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    process.env.TWILIO_CALLER_ID = process.env.TWILIO_CALLER_ID || "+18254511768";
    const app = mountRouter((await import("../routes/webhooks.js")).default, "/api/webhooks");
    const res = await request(app).post("/api/webhooks/twilio/voice/twiml").type("form")
      .send({ From: "client:00000000-0000-0000-0000-000000000099", To: "", CallSid: "CA-empty" });
    expect(res.text).toContain("There is no number to call.");
    expect(h.status).not.toHaveBeenCalled();
  });
});
