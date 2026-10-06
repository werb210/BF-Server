// BF_SERVER_NO_DUPLICATE_ROOMS_v764
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { notifyMeeting, cancelMeetingNotices, type MeetingNotifyDeps } from "../services/meetingNotify.js";
import { recentDuplicateRoom } from "../services/meetingRooms.js";

const room = { id: "r1", code: "799151", slug: "abc123", title: "Test", host_user_id: "u1", application_id: null, contact_id: null, starts_at: "2026-10-06T20:30:00Z", duration_min: 30, status: "scheduled" };
function deps(opts: { eventId?: string | null; claim?: boolean; graphOk?: boolean } = {}) {
  const sql: string[] = [];
  const graph = vi.fn(async (_p: string, _m: string, _b?: unknown) => ({ ok: opts.graphOk ?? true, status: opts.graphOk === false ? 500 : 201, json: { id: "EV9" }, text: "" }));
  const email = vi.fn(async () => ({ ok: true }));
  const d: MeetingNotifyDeps = {
    graphReady: () => true, graph, email, sms: vi.fn(async () => ({ ok: true })),
    query: vi.fn(async (text: string) => {
      sql.push(text);
      if (text.includes("FROM users")) return { rows: [{ name: "Todd", email: "todd@boreal.financial", phone: "403-555-0111" }] };
      if (text.includes("FROM meeting_participants")) return { rows: [] };
      if (text.includes("SELECT graph_event_id")) return { rows: [{ graph_event_id: opts.eventId ?? null, host_email: null }] };
      if (text.includes("LIKE 'pending:%'") && text.startsWith("UPDATE meeting_rooms SET graph_event_id = $2")) return { rows: opts.claim === false ? [] : [{ id: "r1" }] };
      return { rows: [] };
    }),
  };
  return { d, graph, email, sql };
}

describe("a conference room never ends up in Outlook twice", () => {
  it("the request that claims the room creates the one Outlook event", async () => {
    const { d, graph } = deps();
    const out = await notifyMeeting(room, { isNew: true }, d);
    expect(out.calendar).toBe("created");
    expect(graph).toHaveBeenCalledTimes(1);
    expect(graph.mock.calls[0][1]).toBe("POST");
  });
  it("a second request racing on the same room does not create another event or email the invite", async () => {
    const { d, graph, email } = deps({ claim: false });
    const out = await notifyMeeting(room, { isNew: true }, d);
    expect(graph).not.toHaveBeenCalled();
    expect(email).not.toHaveBeenCalled();
    expect(out.calendar).toBe("skipped");
  });
  it("a pending marker is never sent to Outlook as an event id", async () => {
    const { d, graph } = deps({ eventId: "pending:2026-10-06T20:00:00.000Z" });
    await notifyMeeting(room, { isNew: false }, d);
    expect(graph.mock.calls[0][1]).toBe("POST");
    expect(String(graph.mock.calls[0][0])).not.toContain("pending");
    const c = deps({ eventId: "pending:2026-10-06T20:00:00.000Z" });
    await cancelMeetingNotices(room, c.d);
    expect(c.graph).not.toHaveBeenCalled();
  });
  it("when Outlook refuses, the claim is released so a later try can create the event", async () => {
    const { d, sql } = deps({ graphOk: false });
    await notifyMeeting(room, { isNew: true }, d);
    expect(sql.some((t) => t.startsWith("UPDATE meeting_rooms SET graph_event_id = NULL"))).toBe(true);
  });
  it("the same host making the same meeting again within 15 minutes gets the room already made", async () => {
    const query = vi.fn(async (_s: string, _p: unknown[]) => ({ rows: [room] }));
    const dup = await recentDuplicateRoom({ title: "Test", startsAt: new Date(room.starts_at), hostUserId: "u1" }, query);
    expect(dup?.code).toBe("799151");
    const [text, params] = query.mock.calls[0]!;
    expect(text).toContain("created_at > now() - interval '15 minutes'");
    expect(text).toContain("status <> 'cancelled'");
    expect(params).toEqual(["u1", "Test", "2026-10-06T20:30:00.000Z"]);
    expect(readFileSync("src/routes/meetings.ts", "utf8")).toContain("const dup = await recentDuplicateRoom(");
  });
});
