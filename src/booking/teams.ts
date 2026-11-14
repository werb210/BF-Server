// BF_SERVER_BOOKING_TEAMS_v1 - a named team booking page: a fixed group of staff, shared round robin, its own hours
// and its own call lengths. The first one is "pgi" (boreal.financial/book-pgi): Todd and Andrew, for banks, lenders
// and brokers asking about Personal Guarantee Insurance.
import type { BookingHours, BookingKind, MeetingType, Staff } from "../services/clientBooking.js";
import { mailboxOf, TZ } from "../services/clientBooking.js";

export type BookingTeam = {
  slug: string; label: string; emails: string[]; hours: BookingHours; hoursZone: string; tags: string[];
  types: Record<BookingKind, MeetingType>;
  /** Where a booking is also sent as a lead, so it lands in that product's own CRM. */
  leadTo?: "bi";
};

// The team's day is set in its own time zone (Eastern for PGI: 10am to 6pm) and turned into Alberta time, which the
// booking code works in. Alberta is UTC-6 all year and Eastern changes its clocks, so the gap is one hour in winter and
// two in summer: teamHours() works it out for the day it is asked. In the two weeks before a clock change the days
// after the change are offered an hour off; the invitation always shows the true time.
const PGI_DAY: Array<[string, string]> = [["10:00", "18:00"]];
const base = { id: null, description: null, buffer_min: 0, min_notice_min: 120, max_days_ahead: 14 };

export const BOOKING_TEAMS: Record<string, BookingTeam> = {
  pgi: {
    slug: "pgi", label: "Personal Guarantee Insurance", leadTo: "bi", tags: ["pgi_booking"], hoursZone: "America/New_York",
    emails: ["todd.w@boreal.financial", "andrew@boreal.financial", "andrew.p@boreal.financial"],
    hours: { 0: [], 1: PGI_DAY, 2: PGI_DAY, 3: PGI_DAY, 4: PGI_DAY, 5: PGI_DAY, 6: [] },
    types: {
      phone: { ...base, slug: "pgi-call", name: "15-minute phone call", duration_min: 15, kind: "phone" },
      teams: { ...base, slug: "pgi-teams", name: "30-minute Teams meeting", duration_min: 30, kind: "video" },
    },
  },
};

function offsetMin(at: Date, tz: string): number {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).formatToParts(at).map((x) => [x.type, x.value]));
  return Math.round((Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute)) - at.getTime()) / 60_000);
}
const shift = (hhmm: string, byMin: number): string => {
  const [h, m] = hhmm.split(":").map(Number) as [number, number];
  const t = Math.max(0, Math.min(24 * 60, h * 60 + m + byMin));
  return `${String(Math.floor(t / 60)).padStart(2, "0")}:${String(t % 60).padStart(2, "0")}`;
};
/** The team's weekly hours in Alberta time, for the given moment. */
export function teamHours(team: BookingTeam, now: Date = new Date()): BookingHours {
  const by = offsetMin(now, TZ) - offsetMin(now, team.hoursZone);
  return Object.fromEntries(Object.entries(team.hours).map(([dow, spans]) => [dow, spans.map(([a, b]) => [shift(a, by), shift(b, by)] as [string, string])])) as BookingHours;
}

export function bookingTeam(raw: unknown): BookingTeam | null {
  const slug = String(raw ?? "").trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(BOOKING_TEAMS, slug) ? BOOKING_TEAMS[slug]! : null;
}
export function teamMembers(team: BookingTeam, staff: Staff[]): Staff[] {
  return staff.filter((s) => team.emails.includes(s.email.toLowerCase()) || team.emails.includes(mailboxOf(s)));
}
/** A rep code passed along from a rep's link: lower case letters and digits only. */
export function repCode(raw: unknown): string | null {
  const s = String(raw ?? "").trim().toLowerCase();
  return /^[a-z0-9]{4,16}$/.test(s) ? s : null;
}

/** Sends a team booking on as a lead to the product's own server (Boreal Insurance for "pgi"), with the rep who gets
 *  the credit. The booking itself is already made; a failure here is logged and nothing else. */
export async function forwardTeamLead(team: BookingTeam, lead: { name: string; email: string; phone: string | null; rep: string | null }, fetchImpl: typeof fetch = fetch): Promise<boolean> {
  if (team.leadTo !== "bi") return false;
  const base = String(process.env.BI_SERVER_URL ?? "").replace(/\/+$/, "");
  if (!base) { console.warn("[booking] team lead not forwarded: BI_SERVER_URL is not set"); return false; }
  try {
    const r = await fetchImpl(`${base}/api/v1/crm/lead`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ source: "us_lenders_quick", company: `Booked a ${team.label} call`, name: lead.name, email: lead.email, ...(lead.phone ? { phone: lead.phone } : {}), ...(lead.rep ? { rep: lead.rep } : {}) }),
    });
    if (!r.ok) console.warn("[booking] team lead not forwarded", { team: team.slug, status: r.status });
    return r.ok;
  } catch (err) {
    console.warn("[booking] team lead not forwarded", { team: team.slug, message: err instanceof Error ? err.message : String(err) });
    return false;
  }
}
