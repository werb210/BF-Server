// BF_SERVER_v877_NO_NUMBER_CALL - a staff app call with nothing to dial says so and is logged, instead of dropping silently.
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { answerBySql } from "./helpers/answerBySql.js";
import { mountRouter } from "./helpers/staffRouterApp.js";

const h = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("../db.js", async () => ({ ...(await vi.importActual<any>("../db.js")), pool: { query: h.query }, dbQuery: h.query, runQuery: h.query }));
vi.mock("../middleware/twilioWebhookValidation.js", () => {
  const pass = (_req: unknown, _res: unknown, next: () => void) => next();
  return { twilioWebhookValidation: pass, validateTwilioWebhook: pass };
});

beforeEach(() => { h.query.mockReset(); h.query.mockImplementation(answerBySql([])); vi.spyOn(console, "log").mockImplementation(() => undefined); });

describe("staff call with no number", () => {
  it("tells the caller there is no number and logs what the app sent", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    process.env.TWILIO_CALLER_ID = process.env.TWILIO_CALLER_ID || "+18254511768";
    const app = mountRouter((await import("../routes/webhooks.js")).default, "/api/webhooks");
    const res = await request(app).post("/api/webhooks/twilio/voice/twiml").type("form")
      .send({ From: "client:00000000-0000-0000-0000-000000000099", To: "", CallSid: "CA-empty", silo: "BF" });
    expect(res.text).toContain("There is no number to call.");
    expect(res.text).toContain("<Hangup/>");
    const logged = warn.mock.calls.map((c) => String(c[0])).find((l) => l.includes("staff_call_without_number"));
    expect(logged).toBeTruthy();
    expect(JSON.parse(logged!).params).toEqual(["silo"]);
    warn.mockRestore();
  });
});
