// BF_SERVER_v869_PHONE_MENU - the 866 menu as data: the default is the live menu; a saved menu changes what callers hear.
import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const TODD = "11111111-1111-4111-8111-111111111111";
const ANDREW = "22222222-2222-4222-8222-222222222222";
const CADEN = "33333333-3333-4333-8333-333333333333";

const h = vi.hoisted(() => ({
  saved: null as any,
  people: {} as Record<string, any>,
  others: [] as string[],
  writes: [] as Array<{ sql: string; params: any[] }>,
}));

vi.mock("../../middleware/twilioWebhookValidation.js", () => ({ twilioWebhookValidation: (_req: any, _res: any, next: any) => next() }));
vi.mock("../../middleware/auth.js", () => ({
  auth: (req: any, _res: any, next: any) => { req.user = { userId: TODD, id: TODD, role: "Admin" }; next(); },
  requireAuthorization: () => (_req: any, _res: any, next: any) => next(),
}));
vi.mock("../../modules/audit/audit.service.js", () => ({ recordAuditEvent: vi.fn(async () => undefined) }));
vi.mock("../../db.js", () => ({ pool: { query: async (sql: string, params: any[] = []) => {
  if (/INSERT INTO phone_menu_config|DELETE FROM phone_menu_config/.test(sql)) { h.writes.push({ sql, params }); if (/INSERT/.test(sql)) h.saved = JSON.parse(params[0]); else h.saved = null; return { rows: [] }; }
  if (/SELECT config, updated_at FROM phone_menu_config/.test(sql)) return { rows: h.saved ? [{ config: h.saved, updated_at: new Date() }] : [] };
  if (/FROM phone_menu_audio/.test(sql)) return { rows: [] };
  if (/SELECT id::text AS id, first_name, last_name, role FROM users/.test(sql)) {
    return { rows: [{ id: TODD, first_name: "Todd", last_name: "W", role: "Admin" }, { id: ANDREW, first_name: "Andrew", last_name: "P", role: "Staff" }, { id: CADEN, first_name: "Caden", last_name: "W", role: "Staff" }] };
  }
  if (/SELECT id::text AS id FROM users WHERE first_name ILIKE \$1/.test(sql)) return { rows: [{ id: String(params[0]).includes("andrew") ? ANDREW : TODD }] };
  if (sql.includes("SELECT DISTINCT sp.twilio_identity")) return { rows: h.others.map((id) => ({ twilio_identity: id })) };
  if (sql.includes("FROM users u JOIN staff_presence sp") && sql.includes("ILIKE $1")) {
    const key = params[1] ? String(params[1]) : String(params[0]).includes("andrew") ? ANDREW : TODD;
    const p = h.people[key];
    return { rows: p ? [p] : [] };
  }
  return { rows: [] };
} } }));

const person = (id: string, identity: string) => ({ user_id: id, twilio_identity: identity, status: "available", on_call: false, fresh: true, ringable: true, phone: null, standalone_watch: false });

async function voiceApp() {
  const { default: router } = await import("../../routes/reception.js");
  const a = express();
  a.use("/api/webhooks/twilio/reception", router);
  return a;
}
const post = async (path: string, body: Record<string, string> = {}) =>
  (await request(await voiceApp()).post("/api/webhooks/twilio/reception" + path).type("form").send(body)).text;

async function settingsApp() {
  const { default: router } = await import("../../routes/phoneMenu.js");
  const a = express();
  a.use(express.json());
  a.use("/api/phone-menu", router);
  return a;
}

beforeEach(() => {
  h.saved = null;
  h.writes = [];
  h.people = { [TODD]: person(TODD, "todd-app"), [ANDREW]: person(ANDREW, "andrew-app"), [CADEN]: person(CADEN, "caden-app") };
  h.others = ["caden-app"];
  delete process.env.RECEPTION_SALES_USER_ID;
  delete process.env.RECEPTION_UNDERWRITING_USER_ID;
});

describe("the default menu is the live 866 menu", () => {
  it("is a valid menu with the same keys, words and routes", async () => {
    const { defaultBorealMenu, validateMenu, chooseOption, allOptions } = await import("../menu.js");
    const m = defaultBorealMenu();
    expect(validateMenu(m, { userIds: ["@sales", "@underwriting"], audioIds: [] }).ok).toBe(true);
    expect(m.options.map((o) => [o.digit, o.id])).toEqual([["1", "BF"], ["2", "sales"], ["3", "meeting"]]);
    expect(chooseOption(m.options, "", "i'd like to join a meeting about my loan")?.id).toBe("meeting");
    expect(chooseOption(m.options, "", "risk management please")?.id).toBe("sales");
    const sub = (m.options[0]!.target as any).menu;
    expect(chooseOption(sub.options, "", "credit for a new loan")?.id).toBe("underwriting");
    expect(chooseOption(sub.options, "", "i want to apply")?.id).toBe("engagement");
    expect(chooseOption(sub.options, "", "is caden there")?.id).toBe("caden");
    expect(chooseOption(sub.options, "", "renewal")).toBeNull(); // "new" must be said on its own
    expect(allOptions(m)).toHaveLength(7);
  });

  it("answers with the approved greeting and meeting room on 3", async () => {
    const xml = await post("/greeting");
    expect(xml).toContain("This call may be recorded. Thank you for calling the Boreal Group of Companies.");
    expect(await post("/company", { Digits: "3" })).toContain("/meeting");
    expect(await post("/company", { Digits: "3123456" })).toContain("meeting-code?try=0&amp;code=123456");
  });
});

describe("a saved menu", () => {
  it("rings the chosen person by id and sends the caller to their voicemail when unanswered", async () => {
    const { defaultBorealMenu } = await import("../menu.js");
    const m = defaultBorealMenu();
    m.options = [{ id: "jobs", digit: "4", label: "careers", keywords: ["job"], target: { type: "user", userId: CADEN, name: "Caden" } }];
    m.whenNoChoice = { retry: true, optionId: null };
    h.saved = m;
    const xml = await post("/company", { Digits: "4" });
    expect(xml).toContain("One moment, connecting you to Caden.");
    expect(xml).toContain("<Client>caden-app</Client>");
    expect(xml).toContain("unavailable?target=jobs");
    const missed = await post("/unavailable?target=jobs", { DialCallStatus: "no-answer" });
    expect(missed).toContain("Sorry, Caden didn't pick up.");
    expect(missed).toContain(`voicemail?staff=${CADEN}`);
    const unclear = await post("/company", { SpeechResult: "hmm" });
    expect(unclear).toContain("Sorry, I didn't catch that.");
    expect(unclear).toContain("/greeting?again=1");
  });

  it("plays the after-hours greeting on a holiday and takes a message", async () => {
    const { defaultBorealMenu } = await import("../menu.js");
    const { zonedDay } = await import("../../settingsPack/boreal.js");
    const m = defaultBorealMenu();
    m.holidays = [{ date: zonedDay(new Date()), name: "Office party" }];
    h.saved = m;
    const xml = await post("/greeting");
    expect(xml).toContain("Our office is closed right now.");
    expect(xml).toContain("<Record");
    expect(xml).not.toContain("<Gather");
  });

  it("rings a one-at-a-time group in order, then the next person", async () => {
    const { defaultBorealMenu } = await import("../menu.js");
    const m = defaultBorealMenu();
    m.options = [{ id: "team", digit: "1", label: "sales", keywords: [], target: { type: "group", userIds: [ANDREW, CADEN], strategy: "sequential", everyoneAvailable: false, exceptUserIds: [] } }];
    h.saved = m;
    const first = await post("/company", { Digits: "1" });
    expect(first).toContain("<Client>andrew-app</Client>");
    expect(first).not.toContain("caden-app");
    const next = await post(`/group-next?target=team&after=${ANDREW}`, { DialCallStatus: "no-answer" });
    expect(next).toContain("<Client>caden-app</Client>");
  });
});

describe("Settings > Phone menu", () => {
  it("shows the default menu with Todd and Andrew as real people, saves an edit and resets", async () => {
    const app = await settingsApp();
    const got = await request(app).get("/api/phone-menu");
    expect(got.status).toBe(200);
    expect(got.body.is_default).toBe(true);
    const credit = got.body.menu.options[0].target.menu.options.find((o: any) => o.id === "underwriting");
    expect(credit.target.userId).toBe(ANDREW);
    const menu = got.body.menu;
    menu.options[1].label = "Boreal Risk Management";
    menu.greeting.text = "Thank you for calling Boreal.";
    const saved = await request(app).put("/api/phone-menu").send({ menu });
    expect(saved.status).toBe(200);
    expect(h.saved.greeting.text).toBe("Thank you for calling Boreal.");
    const bad = await request(app).put("/api/phone-menu").send({ menu: { ...menu, options: [{ id: "x", digit: "1", label: "Nobody", keywords: [], target: { type: "user", userId: "33333333-0000-4000-8000-000000000000", name: "X" } }] } });
    expect(bad.status).toBe(400);
    expect(Object.values(bad.body.errors)).toContain("Choose an active team member.");
    const reset = await request(app).post("/api/phone-menu/reset");
    expect(reset.status).toBe(200);
    expect(h.saved).toBeNull();
  });
});
