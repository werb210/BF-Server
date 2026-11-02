// BF_SERVER_v869_SETTINGS_PACK - Boreal's fixed answers to what Keystone keeps per licensee: the company name, the
// public phone line, the client app's address and the office time zone. Boreal is one company on Alberta time, which
// is UTC-6 all year (lib/albertaTime.ts, lib/permanentTime.ts), so there is no time-zone setting here on purpose.
import { ALBERTA_TZ } from "../lib/albertaTime.js";
import { zoneOffsetMinutes } from "../lib/permanentTime.js";

export function brandName(): string {
  return "Boreal Financial";
}

/** The 866 main line printed in booking and survey messages. Never a staff member's own cell. */
export function supportPhone(): string {
  return String(process.env.BOREAL_MAIN_LINE_DISPLAY ?? "").trim() || "(866) 631-8939";
}

/** The client app (booking pages, the survey page, the cookie notice). */
export function clientUrl(): string {
  return (String(process.env.CLIENT_URL ?? process.env.CLIENT_APP_URL ?? "").trim() || "https://client.boreal.financial").replace(/\/+$/, "");
}

/** Office hours, bookings and reminders run on Alberta time: UTC-6 all year. */
export function brokerageTimeZone(): string {
  return ALBERTA_TZ;
}
export function brokerageZoneName(): string {
  return ALBERTA_TZ;
}
export function zoneLabel(): string {
  return "Alberta time";
}

export type ZonedParts = { y: number; m: number; d: number; hour: number; minute: number; dow: number };

export function zonedParts(at: Date, tz: string = brokerageTimeZone()): ZonedParts {
  const local = new Date(at.getTime() + zoneOffsetMinutes(at, tz) * 60_000);
  return {
    y: local.getUTCFullYear(), m: local.getUTCMonth() + 1, d: local.getUTCDate(),
    hour: local.getUTCHours(), minute: local.getUTCMinutes(), dow: local.getUTCDay(),
  };
}

/** The UTC instant of y-m-d h:min on the office clock. */
export function zonedTime(y: number, m: number, d: number, h: number, min = 0, tz: string = brokerageTimeZone()): Date {
  const guess = Date.UTC(y, m - 1, d, h, min, 0);
  return new Date(guess - zoneOffsetMinutes(new Date(guess), tz) * 60_000);
}

/** "YYYY-MM-DD" on the office clock. */
export function zonedDay(at: Date, tz: string = brokerageTimeZone()): string {
  const p = zonedParts(at, tz);
  return `${p.y}-${String(p.m).padStart(2, "0")}-${String(p.d).padStart(2, "0")}`;
}

/** Operational email to a client (booking confirmations and reminders, the post-funding survey): SendGrid's
 *  transactional sender, which honours bounces but not marketing unsubscribes. Not configured = not sent (logged by
 *  the caller from the answer). */
export async function sendClientMail(m: { to: string[]; subject: string; html: string; text?: string }): Promise<{ ok: boolean; error?: string }> {
  const { sendgridConfigured, sendTransactional } = await import("../services/sendgridService.js");
  if (!sendgridConfigured()) return { ok: false, error: "sendgrid_not_configured" };
  for (const to of m.to) {
    const r = await sendTransactional({ to, subject: m.subject, html: m.html });
    if (!r.ok) return { ok: false, error: r.error ?? `status_${r.status}` };
  }
  return { ok: true };
}
