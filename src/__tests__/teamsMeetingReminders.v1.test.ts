// BF_SERVER_TEAMS_ATTENDEE_REMINDERS_v1
import { describe, expect, it, vi } from "vitest";
import { answerBySql } from "./helpers/answerBySql.js";
import { sendDueMeetingReminders, reminderMessage, whenText } from "../services/teams/meetingReminders.js";

const NOW = new Date("2026-11-21T15:00:00Z");
const row = { id: "m1", organizer_user_id: "u1", organizer_upn: "todd.w@boreal.financial", subject: "Lender review", graph_event_id: "AAMk1", join_url: "https://teams.microsoft.com/l/meetup-join/x", scheduled_at: "2026-11-21T15:45:00Z" };
const event = (over: Record<string, unknown> = {}) => ({
  subject: "Lender review", start: { dateTime: "2026-11-21T15:45:00.0000000", timeZone: "UTC" }, isCancelled: false,
  organizer: { emailAddress: { address: "Todd.W@boreal.financial", name: "Todd Werboweski" } },
  attendees: [
    { type: "required", emailAddress: { address: "guest@example.com" }, status: { response: "none" } },
    { type: "required", emailAddress: { address: "todd.w@boreal.financial" }, status: { response: "organizer" } },
    { type: "optional", emailAddress: { address: "no@example.com" }, status: { response: "declined" } },
    { type: "resource", emailAddress: { address: "room@boreal.financial" }, status: { response: "accepted" } },
  ], ...over,
});

function setup(claimFor: "24h" | "1h", ev = event()) {
  const query = vi.fn(answerBySql([
    [/UPDATE teams_meetings SET reminder_24h_at/, { rows: claimFor === "24h" ? [row] : [] }],
    [/UPDATE teams_meetings SET reminder_1h_at/, { rows: claimFor === "1h" ? [row] : [] }],
  ]));
  const fetch = vi.fn(async () => new Response(JSON.stringify(ev), { status: 200 }));
  const email = vi.fn(async () => ({ ok: true }));
  return { query, fetch, email, deps: { graphFor: async () => ({ fetch }), email, now: () => NOW } };
}

describe("Teams meeting attendee reminders", () => {
  it("emails each attendee (not the organiser, decliners or rooms) an hour before", async () => {
    const s = setup("1h");
    const r = await sendDueMeetingReminders({ query: s.query }, s.deps);
    expect(r).toEqual({ sent: 1, skipped: 0, errors: 0 });
    expect(s.email).toHaveBeenCalledTimes(1);
    const [to, subject, html, text] = s.email.mock.calls[0]! as unknown as string[];
    expect(to).toBe("guest@example.com");
    expect(subject).toBe("Reminder: Lender review in about an hour");
    expect(html).toContain("https://teams.microsoft.com/l/meetup-join/x");
    expect(text).toContain("with Todd Werboweski");
  });

  it("claims before sending, so a meeting is reminded once", async () => {
    const s = setup("24h");
    await sendDueMeetingReminders({ query: s.query }, s.deps);
    const claim = s.query.mock.calls.find((c) => /reminder_24h_at = \$1/.test(String(c[0])));
    expect(String(claim![0])).toMatch(/reminder_24h_at IS NULL/);
    expect(String(claim![0])).toMatch(/created_at <= scheduled_at - interval '25 hours'/);
  });

  it("skips a cancelled meeting", async () => {
    const s = setup("1h", event({ isCancelled: true }));
    const r = await sendDueMeetingReminders({ query: s.query }, s.deps);
    expect(r.sent).toBe(0);
    expect(s.email).not.toHaveBeenCalled();
  });

  it("writes the time in Mountain Time", () => {
    expect(whenText(new Date("2026-11-21T15:45:00Z"))).toMatch(/9:45 a\.m\. Mountain Time$/);
    expect(reminderMessage({ subject: "X", startsAt: NOW, joinUrl: "https://t", organizerName: null }, "24h").subject).toBe("Reminder: X tomorrow");
  });
});
