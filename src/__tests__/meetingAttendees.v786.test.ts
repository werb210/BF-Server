// BF_SERVER_v786_ROOM_RECORDINGS - POST /api/meetings: contactId is stored on the room, and typed-in
// attendee emails become contacts (found by email in the room's silo, else created with the tag).
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";

const contacts: Array<{ id: string; email: string; silo: string; tags?: string[] }> = [];
const inserted: any[] = [];
const q = vi.fn(async (sql: string, p: any[] = []) => {
  if (sql.includes("FROM meeting_participants WHERE room_id::text = $1")) return { rows: [] };
  if (sql.includes("SELECT COALESCE(silo, 'BF') AS silo FROM meeting_rooms")) return { rows: [{ silo: "BF" }] };
  if (sql.includes("FROM contacts WHERE silo = $1") && sql.includes("lower(email) = lower($2)")) {
    return { rows: contacts.filter((c) => c.silo === p[0] && c.email.toLowerCase() === String(p[1]).toLowerCase()).map((c) => ({ id: c.id })) };
  }
  if (sql.startsWith("INSERT INTO contacts")) { const c = { id: "c-made", email: p[0], silo: p[1], tags: ["meeting_attendee"] }; contacts.push(c); return { rows: [{ id: c.id }] }; }
  if (sql.startsWith("INSERT INTO meeting_participants")) { inserted.push(p); return { rows: [{ id: p[0], contactId: p[2], userId: p[3], name: p[4], email: p[5], phone: p[6], invited_at: null }] }; }
  return { rows: [] };
});
vi.mock("../db.js", () => ({ pool: { query: (sql: string, p?: unknown[]) => q(sql, p as any[]) } }));
vi.mock("../modules/automation/automationEngine.js", () => ({ emitAutomationEvent: vi.fn(async () => undefined) }));

import { addParticipants } from "../services/meetingRooms.js";

const room: any = { id: "room-1", host_user_id: null };

describe("meeting attendees become contacts", () => {
  beforeEach(() => { contacts.length = 0; inserted.length = 0; contacts.push({ id: "c-known", email: "Known@Example.com", silo: "BF" }); });

  it("links a known email, creates an unknown one (email only, meeting_attendee), leaves staff and picked contacts alone", async () => {
    await addParticipants(room, [
      { name: "Known Person", email: "known@example.com" },
      { name: "New Person", email: "new@example.com" },
      { name: "Picked", contactId: "c-picked", email: "picked@example.com" },
      { name: "Staff", userId: "u-1", email: "staff@boreal.financial" },
      { name: "Phone only", phone: "+17805551212" },
    ]);
    expect(inserted.map((p) => [p[4], p[2]])).toEqual([["Known Person", "c-known"], ["New Person", "c-made"], ["Picked", "c-picked"], ["Staff", null], ["Phone only", null]]);
    expect(contacts.find((c) => c.id === "c-made")).toEqual({ id: "c-made", email: "new@example.com", silo: "BF", tags: ["meeting_attendee"] });
    expect(String(q.mock.calls.find((c) => String(c[0]).startsWith("INSERT INTO contacts"))![0])).toContain("ARRAY['meeting_attendee']");
  });

  it("the create route stores a top-level contactId on the room", () => {
    const r = readFileSync("src/routes/meetings.ts", "utf8");
    expect(r).toContain("contactId: typeof req.body?.contactId === \"string\" && /^[0-9a-f-]{36}$/i.test(req.body.contactId) ? req.body.contactId : null");
  });
});
