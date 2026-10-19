// BF_SERVER_DIRECT_LINES_v688
import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { directNumberFor, e164, staffForDirectNumber } from "../voice/directLines.js";
import { mainLineNumber, callerIdForUser } from "../voice/directLines.js";
import { answerBySql, callsMatching, type SqlRule } from "./helpers/answerBySql.js";
import { STAFF_USER_ID, bearer } from "./helpers/staffToken.js";

const h = vi.hoisted(() => ({
  queryMock: vi.fn(),
  dialPstn: vi.fn(async () => "CA-callee"),
  sendViaGraph: vi.fn(async () => ({ ok: true, messageId: null })),
}));
vi.mock("../db.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../db.js")>()),
  pool: { query: h.queryMock, connect: async () => ({ query: h.queryMock, release: () => undefined }) },
  runQuery: h.queryMock,
  dbQuery: h.queryMock,
}));
vi.mock("../voice/conferenceService.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../voice/conferenceService.js")>()),
  createConference: vi.fn(async () => ({ id: "conf-1", friendly_name: "conf-friendly" })),
  addParticipantRow: vi.fn(async () => "pid-1"),
  dialPstnIntoConference: h.dialPstn,
  dialClientIntoConference: vi.fn(async () => "CA-client"),
  getConferenceById: vi.fn(async () => ({ id: "conf-1", friendly_name: "conf-friendly", twilio_conference_sid: null })),
  getParticipantById: vi.fn(async () => null),
  notifyConferenceState: vi.fn(async () => undefined),
}));
vi.mock("../modules/voice/callerDisplay.js", () => ({ resolveDisplayName: vi.fn(async () => "Someone") }));
vi.mock("../middleware/twilioWebhookValidation.js", () => {
  const pass = (_req: unknown, _res: unknown, next: () => void) => next();
  return { twilioWebhookValidation: pass, validateTwilioWebhook: pass };
});
vi.mock("../services/email/graphSendService.js", () => ({ sendViaGraph: h.sendViaGraph }));
vi.mock("../services/clientEmail.js", () => ({ resolveClientEmail: vi.fn(async () => ({ email: "ann@acme.test", firstName: "Ann" })), crmContactEmail: vi.fn(async () => null) }));

const DIRECT = /SELECT direct_number FROM users WHERE id::text = \$1/;

async function voiceApp(directNumber: string | null, extra: SqlRule[] = []) {
  h.queryMock.mockReset();
  h.dialPstn.mockClear();
  h.queryMock.mockImplementation(answerBySql([
    [DIRECT, { rows: [{ direct_number: directNumber }] }],
    [/SELECT 1 FROM conferences c/, { rows: [{ "?column?": 1 }], rowCount: 1 }],
    ...extra,
  ]));
  const { default: router } = await import("../routes/voiceCalls.js");
  const app = express();
  app.use(express.json());
  app.use("/api/voice", router);
  return app;
}

const q = (rows: any[]) => ({ query: async () => ({ rows }) });

describe("v688 staff direct lines", () => {
  it("normalises numbers", () => {
    expect(e164("+1 (825) 451-1768")).toBe("+18254511768");
    expect(e164("8254511768")).toBe("+18254511768");
    expect(e164("18664318939")).toBe("+18664318939");
    expect(e164("451-1768")).toBeNull();
    expect(e164(undefined)).toBeNull();
  });
  it("finds the staff member a direct number belongs to, ringing their Twilio identity", async () => {
    expect(await staffForDirectNumber(q([{ user_id: "u1", first_name: "Andrew", last_name: "Polturak", twilio_identity: "u1" }]), "+1 780 555 0100"))
      .toEqual({ userId: "u1", identity: "u1", name: "Andrew Polturak" });
    expect(await staffForDirectNumber(q([{ user_id: "u2", first_name: "Todd", last_name: null, twilio_identity: null }]), "8254511768"))
      .toEqual({ userId: "u2", identity: "u2", name: "Todd" });
    expect(await staffForDirectNumber(q([]), "+18664318939")).toBeNull();
    expect(await staffForDirectNumber(q([]), "not a number")).toBeNull();
  });
  it("uses a staff member's direct number as their caller ID", async () => {
    expect(await directNumberFor(q([{ direct_number: "(825) 451-1768" }]), "u2")).toBe("+18254511768");
    expect(await directNumberFor(q([{ direct_number: null }]), "u3")).toBeNull();
    expect(await directNumberFor(q([]), null)).toBeNull();
  });
});

describe("v688b: caller ID and receptionist reach", () => {
  it("staff without a direct number call out as the 866 main line", async () => {
    const prev = process.env.TWILIO_MAIN_LINE_NUMBER; delete process.env.TWILIO_MAIN_LINE_NUMBER;
    expect(mainLineNumber()).toBe("+18666318939");
    expect(await callerIdForUser({ query: async () => ({ rows: [{ direct_number: null }] }) }, "u3")).toBe("+18666318939");
    expect(await callerIdForUser({ query: async () => ({ rows: [{ direct_number: "5874165992" }] }) }, "u1")).toBe("+15874165992");
    if (prev !== undefined) process.env.TWILIO_MAIN_LINE_NUMBER = prev;
  });
  it("an outbound call shows the caller's direct number, else the 866 main line", async () => {
    delete process.env.TWILIO_MAIN_LINE_NUMBER;
    let app = await voiceApp("(825) 555-0199");
    const res = await request(app).post("/api/voice/calls").set("Authorization", bearer("Staff")).send({ to: "+15875550100" });
    expect(res.status).toBe(200);
    expect(h.dialPstn).toHaveBeenCalledWith(expect.objectContaining({ toNumber: "+15875550100", fromNumber: "+18255550199" }));
    expect(callsMatching(h.queryMock, DIRECT)[0]![1]).toEqual([STAFF_USER_ID]);

    app = await voiceApp(null);
    await request(app).post("/api/voice/calls").set("Authorization", bearer("Staff")).send({ to: "+15875550100" });
    expect(h.dialPstn).toHaveBeenCalledWith(expect.objectContaining({ fromNumber: "+18666318939" }));
  });

  it("add-a-caller and transfer use the same caller ID", async () => {
    const app = await voiceApp("(825) 555-0199");
    const add = await request(app).post("/api/voice/conferences/conf-1/participants").set("Authorization", bearer("Staff")).send({ phone: "5875550111" });
    expect(add.status).toBe(200);
    const transfer = await request(app).post("/api/voice/conferences/conf-1/transfer").set("Authorization", bearer("Staff")).send({ mode: "warm", target: { phone: "5875550122" } });
    expect(transfer.status).toBe(200);
    expect(h.dialPstn.mock.calls.map((c: any[]) => [c[0].toNumber, c[0].fromNumber])).toEqual([
      ["+15875550111", "+18255550199"],
      ["+15875550122", "+18255550199"],
    ]);
    // BF_SERVER_v789 - the participant id reaches the dial (it sat inside a comment before).
    for (const c of h.dialPstn.mock.calls as any[][]) expect(c[0].participantId).toBeTruthy();
  });

  it("the receptionist counts the dialler app as signed in", async () => {
    h.queryMock.mockReset();
    h.queryMock.mockImplementation(answerBySql([
      [/FROM staff_device_credentials dc WHERE dc\.user_id = u\.id/, (sql: string) => sql.includes("sp.status, sp.twilio_identity")
        ? { rows: [{ status: "available", twilio_identity: "andrew-device", on_call: false, fresh: true, phone: null, standalone_watch: false, user_id: "u-andrew" }] }
        : { rows: [] }],
    ]));
    const { default: reception } = await import("../routes/reception.js");
    const app = express();
    app.use("/api/webhooks/twilio/reception", reception);
    const res = await request(app).post("/api/webhooks/twilio/reception/intent?company=BF").type("form").send({ Digits: "2", CallSid: "CA1", From: "+15875550100" });
    expect(res.status).toBe(200);
    expect(res.text).toMatch(/<Client[^>]*>andrew-device<\/Client>/);
    const lookup = callsMatching(h.queryMock, /sp\.status, sp\.twilio_identity/);
    expect(String(lookup[0]![0])).toMatch(/last_heartbeat > now\(\) - interval '90 seconds'\) OR EXISTS \(\s*SELECT 1 FROM staff_device_credentials dc/);
  });

  it("rejection emails give the 866", async () => {
    h.queryMock.mockReset();
    h.queryMock.mockImplementation(answerBySql([
      [/SET rejection_email_sent_at = NOW\(\)/, { rows: [{ already: "app-1" }] }],
      [/FROM application_rejection_reasons/, { rows: [{ code: "tib", label: "Time in business", why_it_matters: "Lenders want history.", what_helps: null }] }],
    ]));
    const { sendRejectionNoticeToClient } = await import("../services/rejectionNotice.js");
    expect(await sendRejectionNoticeToClient("app-1")).toEqual({ sent: true });
    const mail = (h.sendViaGraph.mock.calls[0] as unknown[])[0] as { bodyText: string; bodyHtml: string };
    for (const body of [mail.bodyText, mail.bodyHtml]) {
      expect(body).toContain("+1 (866) 631-8939");
      expect(body).not.toContain("451-1768");
    }
  });
});

describe("v688c: no staff cell numbers in code", () => {
  const STAFF_CELLS = /587.?888.?1837|780.?264.?8467/;

  it("seeds read settings", async () => {
    vi.resetModules();
    process.env.BOOTSTRAP_ADMIN_PHONE = "(587) 555-0123";
    const seeded = await import("../db/seed.js");
    expect(seeded.SEEDED_ADMIN_PHONE).toBe("+15875550123");

    vi.resetModules();
    delete process.env.BOOTSTRAP_ADMIN_PHONE;
    delete process.env.BOOTSTRAP_ADMIN2_PHONE;
    const unset = await import("../db/seed.js");
    for (const p of [unset.SEEDED_ADMIN_PHONE, unset.SEEDED_ADMIN2_PHONE]) {
      expect(p).toMatch(/^\+1\d{3}555\d{4}$/); // a reserved 555 placeholder, never a person
      expect(p).not.toMatch(STAFF_CELLS);
    }
  });

  it("a production boot without BOOTSTRAP_ADMIN_PHONE seeds nobody", async () => {
    vi.resetModules();
    delete process.env.BOOTSTRAP_ADMIN_PHONE;
    h.queryMock.mockReset();
    h.queryMock.mockImplementation(answerBySql([]));
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const { seedAdminUser } = await import("../db/seed.js");
      await seedAdminUser();
      expect(callsMatching(h.queryMock, /users/)).toHaveLength(0);
      expect(warn).toHaveBeenCalledWith("[seed] BOOTSTRAP_ADMIN_PHONE not set - first admin not seeded");
    } finally {
      process.env.NODE_ENV = prev;
      warn.mockRestore();
    }
  });

  it("the abandoned-list exclusions come from settings, not code", async () => {
    for (const [setting, expected] of [[undefined, []], ["780 555 0100, +1 (587) 555-0199", ["7805550100", "5875550199"]]] as const) {
      vi.resetModules();
      if (setting === undefined) delete process.env.ABANDONED_EXCLUDE_PHONES;
      else process.env.ABANDONED_EXCLUDE_PHONES = setting;
      h.queryMock.mockReset();
      h.queryMock.mockImplementation(answerBySql([]));
      const { default: marketing } = await import("../routes/marketing.js");
      const app = express();
      app.use("/api/marketing", marketing);
      expect((await request(app).get("/api/marketing/abandoned").set("Authorization", bearer("Admin"))).status).toBe(200);
      const params = callsMatching(h.queryMock, /AND a\.submitted_at IS NULL/)[0]![1] as unknown[];
      expect(params[2]).toEqual(expected);
    }
    delete process.env.ABANDONED_EXCLUDE_PHONES;
  }, 60_000);
});
