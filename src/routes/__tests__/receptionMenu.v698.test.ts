// BF_SERVER_RECEPTION_MENU_v698
import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  people: {} as Record<string, { user_id: string; twilio_identity: string; status: string; on_call: boolean; fresh: boolean; phone: null; standalone_watch: boolean } | undefined>,
  others: [] as string[],
}));
vi.mock("../../middleware/twilioWebhookValidation.js", () => ({ twilioWebhookValidation: (_req: any, _res: any, next: any) => next() }));
vi.mock("../../db.js", () => ({ pool: { query: async (sql: string, params: any[] = []) => {
  if (sql.includes("SELECT DISTINCT sp.twilio_identity")) return { rows: state.others.map((id) => ({ twilio_identity: id })) };
  if (sql.includes("FROM users u JOIN staff_presence sp") && sql.includes("ILIKE $1")) {
    const p = state.people[String(params[0]).includes("andrew") ? "andrew" : "todd"];
    return { rows: p ? [p] : [] };
  }
  return { rows: [] };
} } }));
const person = (id: string) => ({ user_id: id, twilio_identity: id, status: "available", on_call: false, fresh: true, phone: null, standalone_watch: false });
async function app() { const { default: router } = await import("../reception.js"); const a = express(); a.use("/api/webhooks/twilio/reception", router); return a; }
const post = async (path: string, body: Record<string, string> = {}) => (await request(await app()).post("/api/webhooks/twilio/reception" + path).type("form").send(body)).text;
beforeEach(() => { state.people = { todd: person("todd-id"), andrew: person("andrew-id") }; state.others = ["caden-id"]; });

describe("v698 receptionist menu", () => {
  it("opens with recording notice and both companies", async () => { const xml = await post("/greeting"); expect(xml).toContain("This call may be recorded. Thank you for calling the Boreal Group of Companies."); expect(xml).toContain("press 1 for Financial, 2 for Risk Management"); });
  it("plays the Financial menu without old wording", async () => { const xml = await post("/company", { Digits: "1" }); expect(xml).toContain("For client engagement, press 1. For credit, press 2."); expect(xml).not.toMatch(/sales|underwriting/i); });
  it("routes Risk Management to Todd only", async () => { expect(await post("/company", { Digits: "2" })).toContain("/intent?company=BRM"); const xml = await post("/intent?company=BRM"); expect(xml).toContain("<Client>todd-id</Client>"); expect(xml).not.toContain("andrew-id"); expect(xml).not.toContain("caden-id"); });
  it("rings client engagement together without Andrew", async () => { const xml = await post("/intent?company=BF", { Digits: "1" }); expect(xml).toContain("<Client>todd-id</Client>"); expect(xml).toContain("<Client>caden-id</Client>"); expect(xml).not.toContain("andrew-id"); expect(xml).toContain("target=engagement"); });
  it("rings Andrew only for credit", async () => { const xml = await post("/intent?company=BF", { Digits: "2" }); expect(xml).toContain("<Client>andrew-id</Client>"); expect(xml).not.toContain("todd-id"); expect(xml).not.toContain("caden-id"); });
  it("uses Andrew's voicemail when away", async () => { state.people.andrew = undefined; const xml = await post("/intent?company=BF", { Digits: "2" }); expect(xml).toContain("<Record"); expect(xml).not.toContain("<Client>"); });
  it("retries once then defaults to engagement", async () => { const first = await post("/intent?company=BF"); expect(first).toContain("For client engagement, press 1. For credit, press 2."); expect(first).toContain("retry=1"); const second = await post("/intent?company=BF&retry=1"); expect(second).toContain("<Client>todd-id</Client>"); expect(second).toContain("<Client>caden-id</Client>"); });
  it("uses shared voicemail when engagement is unavailable", async () => { state.people.todd = undefined; state.others = []; const xml = await post("/intent?company=BF", { Digits: "1" }); expect(xml).toContain("<Record"); expect(xml).not.toContain("voicemail?staff="); const missed = await post("/unavailable?target=engagement", { DialCallStatus: "no-answer" }); expect(missed).toContain("<Record"); expect(missed).not.toContain("voicemail?staff="); });
});
