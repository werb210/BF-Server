// BF_SERVER_BLOCK_v557_WATCH_NEXT_MEETING
// The Watch complication's "next meeting" line. The iPhone used to publish it
// into its own app group, which the Watch cannot read, so the line never showed.
// The Watch already fetches /api/watch/face itself; the meeting now rides along.
// Read from the user's Outlook calendar (next 24 h), cached 5 minutes per user so
// a face refresh every 15 minutes is at most one Graph call. Never throws.
export type NextMeeting = { title: string; startsAt: string } | null;
type GraphEvent = {
  subject?: string | null;
  isCancelled?: boolean;
  isAllDay?: boolean;
  showAs?: string;
  start?: { dateTime?: string; timeZone?: string };
};
type Deps = { fetchEvents: (userId: string, now: Date) => Promise<GraphEvent[]>; now: () => Date };

export function pickNextMeeting(events: GraphEvent[], now: Date = new Date()): NextMeeting {
  for (const e of events ?? []) {
    if (!e || e.isCancelled || e.isAllDay || e.showAs === "free") continue;
    const raw = e.start?.dateTime;
    if (!raw) continue;
    // Graph returns UTC without a zone suffix when asked for outlook.timezone="UTC".
    const at = new Date(/([zZ]|[+-]\d\d:?\d\d)$/.test(raw) ? raw : `${raw}Z`);
    if (!Number.isFinite(at.getTime()) || at.getTime() <= now.getTime()) continue;
    return { title: String(e.subject ?? "").trim().slice(0, 80) || "Meeting", startsAt: at.toISOString() };
  }
  return null;
}

const TTL_MS = 5 * 60 * 1000;
const cache = new Map<string, { at: number; value: NextMeeting }>();

export async function nextMeetingFor(userId: string, deps: Deps = defaultDeps): Promise<NextMeeting> {
  if (!userId) return null;
  const now = deps.now();
  const hit = cache.get(userId);
  if (hit && now.getTime() - hit.at < TTL_MS && (!hit.value || Date.parse(hit.value.startsAt) > now.getTime())) {
    return hit.value;
  }
  let value: NextMeeting = null;
  try {
    value = pickNextMeeting(await deps.fetchEvents(userId, now), now);
  } catch (err: any) {
    console.warn("[watch-face] next_meeting_failed", { userId, message: err?.message });
  }
  cache.set(userId, { at: now.getTime(), value });
  return value;
}

const defaultDeps: Deps = {
  now: () => new Date(),
  async fetchEvents(userId, now) {
    const { pool } = await import("../db.js");
    const { getGraphForUser } = await import("../modules/o365/graphClient.js");
    const graph = await getGraphForUser(pool, userId).catch(() => null);
    if (!graph) return [];
    const start = encodeURIComponent(now.toISOString());
    const end = encodeURIComponent(new Date(now.getTime() + 24 * 3600 * 1000).toISOString());
    const resp = await graph.fetch(
      `/me/calendarView?startDateTime=${start}&endDateTime=${end}&$top=10&$orderby=start/dateTime&$select=subject,start,isCancelled,isAllDay,showAs`,
      { headers: { Prefer: 'outlook.timezone="UTC"' } },
    );
    if (!resp.ok) throw new Error(`graph_${resp.status}`);
    const body = (await resp.json()) as { value?: GraphEvent[] };
    return Array.isArray(body.value) ? body.value : [];
  },
};

export function __clearNextMeetingCache(): void {
  cache.clear();
}
