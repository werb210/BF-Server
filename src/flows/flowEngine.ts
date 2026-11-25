// BF_SERVER_CRM_FLOWS_v1 - the rules of an email flow (the same as BI-Server services/flows/flowEngine.ts), with no
// database or network in them.
//
// Everyone gets "e1". After that the person's own behaviour picks the next email:
//   never opened            -> n2, n3, n4, one a week, then rested
//   opened (no click)       -> o1 two business days after the open, then o2 a week later, then rested
//   clicked a link          -> c1 straight away (in sending hours) and a call task for the owner, then done
// A person only moves up (none -> opened -> clicked), never back.
import { nextSendableAt, type SendWindow } from "./sendWindow.js";

export const FLOW_KEYS = ["e1", "n2", "n3", "n4", "o1", "o2", "c1"] as const;
export type FlowKey = (typeof FLOW_KEYS)[number];
export type Track = "none" | "opened" | "clicked";
export const FLOW_KEY_LABEL: Record<FlowKey, string> = {
  e1: "First email (everyone)", n2: "Not opened, week 1", n3: "Not opened, week 2", n4: "Not opened, week 3 (last)",
  o1: "Opened: more details", o2: "Opened: example", c1: "Clicked: let's talk",
};
export const isFlowKey = (v: unknown): v is FlowKey => typeof v === "string" && (FLOW_KEYS as readonly string[]).includes(v);

export const FLOW_WINDOW: SendWindow = { startHour: 9, endHour: 17, weekdaysOnly: true };
const DAY = 86_400_000;
export const NO_OPEN_GAP_DAYS = 7;
export const OPEN_FOLLOW_UP_BUSINESS_DAYS = 2;
/** A click this soon after the email left is a mail filter scanning the link, not a person. */
export const ROBOT_CLICK_SECONDS = 60;
/** This many different links clicked at the same moment is a scanner too. */
export const ROBOT_CLICK_LINKS = 3;

export type Next = { key: FlowKey; at: Date } | null;

/** Weekdays only; the result keeps the time of day. */
export function addBusinessDays(from: Date, days: number): Date {
  const d = new Date(from);
  let left = Math.max(0, Math.trunc(days));
  while (left > 0) {
    d.setUTCDate(d.getUTCDate() + 1);
    const wd = d.getUTCDay();
    if (wd !== 0 && wd !== 6) left -= 1;
  }
  return d;
}
const inHours = (at: Date): Date => nextSendableAt(at, FLOW_WINDOW);

/** What comes after `key` has just gone out, for a person on `track`. null = the flow is finished for them. */
export function nextAfterSend(key: FlowKey, track: Track, sentAt: Date): Next {
  if (track === "clicked") return null; // c1 is the last email; a click during o1/n2 is handled by onClick
  if (track === "opened") {
    if (key === "o1") return { key: "o2", at: inHours(new Date(sentAt.getTime() + NO_OPEN_GAP_DAYS * DAY)) };
    if (key === "o2") return null;
    return null;
  }
  const order: FlowKey[] = ["e1", "n2", "n3", "n4"];
  const i = order.indexOf(key);
  const nextKey = i >= 0 ? order[i + 1] : undefined;
  return nextKey ? { key: nextKey, at: inHours(new Date(sentAt.getTime() + NO_OPEN_GAP_DAYS * DAY)) } : null;
}

export type MemberState = { track: Track; sentKeys: string[]; lastSentAt: Date | null };

/** An open moves a never-opened person to the "more details" email, two business days later. */
export function onOpen(m: MemberState, at: Date): { track: Track; next: Next } | null {
  if (m.track !== "none" || m.sentKeys.length === 0) return null;
  if (m.sentKeys.includes("o1")) return { track: "opened", next: null };
  return { track: "opened", next: { key: "o1", at: inHours(addBusinessDays(at, OPEN_FOLLOW_UP_BUSINESS_DAYS)) } };
}

export type Click = { at: Date; url: string };
/** True when the click looks like a security filter and not a person. `nearby` = this person's clicks around it. */
export function isRobotClick(click: Click, lastSentAt: Date | null, nearby: Click[] = []): boolean {
  if (lastSentAt && click.at.getTime() - lastSentAt.getTime() < ROBOT_CLICK_SECONDS * 1000) return true;
  const sameMoment = new Set(nearby.filter((c) => Math.abs(c.at.getTime() - click.at.getTime()) <= 5000).map((c) => c.url));
  sameMoment.add(click.url);
  return sameMoment.size >= ROBOT_CLICK_LINKS;
}
const isUnsubscribeUrl = (url: string): boolean => /unsubscribe|asm\/|\/wf\/unsubscribe|preferences/i.test(url);

/** A real click sends the "let's talk" email and asks for a call. */
export function onClick(m: MemberState, click: Click, nearby: Click[] = []): { track: Track; next: Next } | null {
  if (m.track === "clicked" || m.sentKeys.length === 0) return null;
  if (isUnsubscribeUrl(click.url) || isRobotClick(click, m.lastSentAt, nearby)) return null;
  if (m.sentKeys.includes("c1")) return { track: "clicked", next: null };
  return { track: "clicked", next: { key: "c1", at: inHours(click.at) } };
}

/** New people started per day: the starting number, doubling each full week the flow has run, 1,000 at most. */
export function dailyNewCap(dailyNew: number, startedAt: Date | null, now: Date): number {
  const base = Math.max(1, Math.min(1000, Math.trunc(Number(dailyNew) || 100)));
  if (!startedAt) return base;
  const weeks = Math.max(0, Math.floor((now.getTime() - startedAt.getTime()) / (7 * DAY)));
  return Math.min(1000, base * 2 ** Math.min(weeks, 10));
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
/** The sender and postal address the law asks for, per business. */
export const POSTAL_LINES: Record<string, string> = {
  BF: "Boreal Financial, 450 Sparling Crt SW, Edmonton, Alberta T6X 1G9, Canada",
  KS: "Keystone (2630108 Alberta Ltd.), 450 Sparling Crt SW, Edmonton, Alberta T6X 1G9, Canada",
  SLF: "Site Level Financial, 450 Sparling Crt SW, Edmonton, Alberta T6X 1G9, Canada",
};
export const postalLine = (silo: string): string => POSTAL_LINES[String(silo ?? "BF").toUpperCase()] ?? POSTAL_LINES.BF!;
/** The email as sent: the written body plus who it is from, the postal address and an unsubscribe link. */
export function withFooter(bodyHtml: string, fromName: string, silo = "BF", unsubscribeUrl = "<%asm_group_unsubscribe_raw_url%>"): string {
  const unsub = unsubscribeUrl ? ` &middot; <a href="${unsubscribeUrl}" style="color:#6b7280">Unsubscribe</a>` : "";
  return `<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.5;color:#111827">${bodyHtml}`
    + `<p style="font-size:12px;color:#6b7280;margin-top:28px;border-top:1px solid #e5e7eb;padding-top:10px">${esc(fromName)} &middot; ${esc(postalLine(silo))}${unsub}</p></div>`;
}
export function htmlToText(html: string): string {
  return html.replace(/<a [^>]*href="([^"]+)"[^>]*>(.*?)<\/a>/gi, "$2: $1").replace(/<\/(p|li|h\d)>/gi, "\n\n").replace(/<br\s*\/?>/gi, "\n")
    .replace(/<li>/gi, "- ").replace(/<[^>]+>/g, "").replace(/&middot;/g, "-").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/\n{3,}/g, "\n\n").trim();
}
/** job id carried on every flow email so its opens and clicks come back to the right flow and email. "crmflow:" is not
 *  BI-Server's "flow:" prefix, so the SendGrid webhook never forwards these to BI. */
export const flowJobId = (flowId: string, key: FlowKey): string => `crmflow:${flowId}:${key}`;
export function parseFlowJobId(v: unknown): { flowId: string; key: FlowKey } | null {
  const m = /^crmflow:([0-9a-f-]{36}):([a-z0-9]+)$/i.exec(String(v ?? ""));
  return m && isFlowKey(m[2]) ? { flowId: m[1]!, key: m[2] } : null;
}
