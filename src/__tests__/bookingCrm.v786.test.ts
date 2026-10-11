// BF_SERVER_v786_BOOKING_CRM - phone validation, CRM records before the Outlook event, the CRM meeting
// row, owner fill, automation events, and a failed Outlook call keeping the CRM records.
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

const log: string[] = [];
const db = { existing: null as null | { id: string; name: string | null; email: string | null; phone: string | null; owner_id: string | null } };
const q = vi.fn(async (sql: string, p: any[] = []) => {
  const s = String(sql);
  if (/FROM users/.test(s) && /o365_user_email/.test(s)) return { rows: [{ id: "u-todd", email: "todd.w@boreal.financial", first_name: "Todd", mailbox: "todd.w@boreal.financial", signed_in: true }] };
  if (s.includes("FROM client_bookings WHERE status = 'booked'")) return { rows: [] };
  if (s.includes("max(created_at) AS last_at")) return { rows: [] };
  if (s.includes("SELECT id::text, name, email, phone, owner_id::text FROM contacts")) { log.push("contact.find"); return { rows: db.existing ? [db.existing] : [] }; }
  if (s.startsWith("INSERT INTO contacts")) { log.push("contact.insert"); return { rows: [{ id: "c-new" }] }; }
  if (s.startsWith("UPDATE contacts")) { log.push("contact.update"); return { rows: [] }; }
  if (s.startsWith("INSERT INTO client_bookings")) { log.push("booking.insert"); return { rows: [] }; }
  if (s.startsWith("INSERT INTO crm_meetings")) { log.push("meeting.insert"); return { rows: [] }; }
  if (s.startsWith("UPDATE client_bookings SET status = 'failed'")) { log.push("booking.failed"); return { rows: [] }; }
  if (s.startsWith("UPDATE crm_meetings SET status = 'failed'")) { log.push("meeting.failed"); return { rows: [] }; }
  if (s.startsWith("UPDATE client_bookings SET graph_event_id")) { log.push("booking.graph"); return { rows: [] }; }
  if (s.startsWith("UPDATE crm_meetings SET graph_id")) { log.push("meeting.graph"); return { rows: [] }; }
  return { rows: [] };
});
vi.mock("../db.js", () => ({ pool: { query: (sql: string, params?: unknown[]) => q(sql, params as any[]) } }));
const graphOk = { ok: true, status: 201, json: async () => ({ id: "evt-1", onlineMeeting: { joinUrl: "https://teams.example/j" } }), text: async () => "" };
const graphAppFetch = vi.fn(async (..._a: any[]) => { log.push("graph.event"); return graphOk as any; });
vi.mock("../services/teams/graphAppClient.js", () => ({ isAppGraphConfigured: () => false, graphAppFetch: (...a: any[]) => graphAppFetch(...a) }));
const emitAutomationEvent = vi.fn(async () => undefined);
vi.mock("../modules/automation/automationEngine.js", () => ({ emitAutomationEvent: (...a: any[]) => (emitAutomationEvent as any)(...a) }));

import { bookingPhoneE164, createBooking, candidateSlots } from "../services/clientBooking.js";
import bookingRouter from "../routes/clientBooking.js";

const NOW = new Date("2026-10-12T15:00:00Z"); // Monday 09:00 Alberta
const SLOT = candidateSlots(NOW)[0]!;
const call = (over: any = {}) => createBooking({ kind: "phone", startsAt: SLOT, staffId: "u-todd", name: "Pat Lee", email: "pat@example.com", phone: "+17805551212", notes: null, now: NOW, ...over });
const paramsOf = (start: string) => q.mock.calls.find((c) => String(c[0]).startsWith(start))![1] as any[];

describe("booking phone numbers", () => {
  it("accepts 10 digits or 11 starting with 1, formatting ignored, as E.164", () => {
    expect(bookingPhoneE164("(780) 555-1212")).toBe("+17805551212");
    expect(bookingPhoneE164("1-780-555-1212")).toBe("+17805551212");
    expect(bookingPhoneE164("+1 780.555.1212")).toBe("+17805551212");
    expect(bookingPhoneE164("780-555-121")).toBeNull();
    expect(bookingPhoneE164("2-780-555-1212")).toBeNull();
    expect(bookingPhoneE164("+44 20 7946 0958")).toBeNull();
  });
  it("a phone booking with anything else is 400 invalid_phone", async () => {
    const app = express(); app.use(express.json()); app.use("/api/client/booking", bookingRouter);
    for (const phone of ["555-1212", "2-780-555-1212", "", "+44 20 7946 0958"]) {
      const r = await request(app).post("/api/client/booking").set("X-Forwarded-For", "10.0.0." + phone.length)
        .send({ kind: "phone", name: "Pat", email: "pat@example.com", phone, startsAt: SLOT.toISOString() });
      expect(r.status).toBe(400);
      expect(r.body).toEqual({ error: "invalid_phone" });
    }
  });
});

describe("booking writes the CRM first", () => {
  beforeEach(() => { log.length = 0; db.existing = null; graphAppFetch.mockImplementation(async () => { log.push("graph.event"); return graphOk as any; }); });

  it("creates the contact (owner = booked staff), the booking and the meeting row, then the Outlook event", async () => {
    const out = await call();
    expect(out.ok).toBe(true);
    expect(log).toEqual(["contact.find", "contact.insert", "booking.insert", "meeting.insert", "graph.event", "booking.graph", "meeting.graph"]);
    expect(paramsOf("INSERT INTO contacts").slice(1, 5)).toEqual(["Pat Lee", "pat@example.com", "+17805551212", "u-todd"]);
    const m = paramsOf("INSERT INTO crm_meetings");
    expect(m[1]).toBe("Phone call with Pat Lee - Boreal Financial");
    expect(m[3]).toBe(SLOT.toISOString());
    expect(m[4]).toBe(new Date(SLOT.getTime() + 30 * 60_000).toISOString());
    expect(m[5]).toBe("Phone call - Boreal calls +17805551212");
    expect(m.slice(7, 10)).toEqual(["u-todd", "c-new", "phone"]);
    const ev = JSON.parse((graphAppFetch.mock.calls[0]![1] as any).body);
    expect(ev.subject).toBe(m[1]);
    expect(ev.location.displayName).toBe("Phone call - Boreal calls +17805551212");
    expect(emitAutomationEvent).toHaveBeenCalledWith("contact.created", expect.objectContaining({ contactId: "c-new", data: { source: "booking" } }));
    expect(emitAutomationEvent).toHaveBeenCalledWith("booking.created", expect.objectContaining({ contactId: "c-new" }));
  });

  it("an existing contact (matched by email or last 10 phone digits) gets missing fields, the tag and an owner if none", async () => {
    db.existing = { id: "c-old", name: null, email: "pat@example.com", phone: null, owner_id: null };
    emitAutomationEvent.mockClear();
    await call({ kind: "teams" });
    expect(log.slice(0, 4)).toEqual(["contact.find", "contact.update", "booking.insert", "meeting.insert"]);
    expect(String(q.mock.calls.find((c) => String(c[0]).startsWith("UPDATE contacts"))![0])).toContain("owner_id = COALESCE(owner_id, $5::uuid)");
    expect(paramsOf("UPDATE contacts")).toEqual(["c-old", "Pat Lee", "pat@example.com", "+17805551212", "u-todd"]);
    expect(paramsOf("SELECT id::text, name, email, phone, owner_id::text FROM contacts")).toEqual(["pat@example.com", "+17805551212"]);
    expect(paramsOf("INSERT INTO crm_meetings")[9]).toBe("teams");
    expect(emitAutomationEvent.mock.calls.map((c: any[]) => c[0])).toEqual(["booking.created"]);
  });

  it("if Outlook fails the CRM records stay, are marked failed, and the API answers 503", async () => {
    graphAppFetch.mockImplementation(async () => { log.push("graph.event"); return { ok: false, status: 500, text: async () => "boom", json: async () => ({}) } as any; });
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await expect(call()).rejects.toThrow(/graph_create_event_failed/);
    expect(log).toEqual(["contact.find", "contact.insert", "booking.insert", "meeting.insert", "graph.event", "booking.failed", "meeting.failed"]);
    expect(err).toHaveBeenCalledWith(expect.stringContaining("Outlook event failed"), expect.objectContaining({ contactId: "c-new" }));
    const app = express(); app.use(express.json()); app.use("/api/client/booking", bookingRouter);
    const r = await request(app).post("/api/client/booking").set("X-Forwarded-For", "10.9.9.9")
      .send({ kind: "phone", name: "Pat", email: "pat@example.com", phone: "780 555 1212", startsAt: candidateSlots(new Date())[0]!.toISOString(), staffId: "u-todd" });
    expect(r.status).toBe(503);
    err.mockRestore();
  });
});
