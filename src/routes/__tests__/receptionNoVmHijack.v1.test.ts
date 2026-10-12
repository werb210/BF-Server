// BF_SERVER_RECEPTION_NO_VM_HIJACK_v1
import { describe, it, expect, vi } from "vitest";
import express from "express";
import request from "supertest";
import twilio from "twilio";
import { answerBySql } from "../../__tests__/helpers/answerBySql.js";

const h = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("../../db", async () => {
  const actual = await vi.importActual<typeof import("../../db.js")>("../../db");
  return { ...actual, pool: { query: h.query }, runQuery: h.query, dbQuery: h.query, query: h.query };
});
vi.mock("twilio", async () => await vi.importActual<typeof import("twilio")>("twilio"));

describe("reception no voicemail hijack", () => {
  it("dials the browser client OR the cell, never both in parallel", async () => {
    // BF_SERVER_BLOCK_v567 - client branch returns before any cell dial. A cell dialled in
    // parallel answers with its own voicemail first and takes the call away from the client.
    h.query.mockImplementation(answerBySql([
      [/FROM users u JOIN staff_presence sp ON sp\.user_id = u\.id\s+WHERE \(u\.first_name ILIKE \$1/, {
        rows: [{ status: "available", twilio_identity: "andrew-client", on_call: false, fresh: true, phone: "4035550100", standalone_watch: true, user_id: "22222222-2222-4222-8222-222222222222" }],
      }],
    ]));
    const router = (await import("../reception.js")).default;
    const app = express();
    app.use("/api/webhooks/twilio/reception", router);
    const full = "/api/webhooks/twilio/reception/intent?company=BF";
    const params = { Digits: "2" };
    const res = await request(app).post(full).type("form").set("X-Forwarded-Host", "example.com").set("X-Forwarded-Proto", "https")
      .set("X-Twilio-Signature", twilio.getExpectedTwilioSignature(String(process.env.TWILIO_AUTH_TOKEN), "https://example.com" + full, params))
      .send(params);
    expect(res.status).toBe(200);
    expect(res.text.match(/<Dial/g)?.length).toBe(1);
    expect(res.text).toContain("<Client>andrew-client</Client>");
    expect(res.text).not.toContain("<Number>");
  });
});
