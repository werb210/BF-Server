// BF_SERVER_MAYA_ADS_INSIGHTS_v712 - Boreal's standing Google Ads rules, applied to
// every suggestion Maya makes (portal panel, Monday email, chat tools).
import type { Suggestion } from "./googleAdsSuggestions.js";

export const ADS_RULES = [
  "Suggest only: nothing changes in Google Ads without a person approving it.",
  "Budgets and bid strategy are Todd's decision alone - mention them as advice, never as an action to apply.",
  "Never advertise in Quebec.",
  "No demographic targeting (age, gender, household income) - these are credit ads.",
  "While Google Ads records no conversions, do not suggest pausing anything: zero conversions says nothing yet.",
];

export const TODD_ONLY_KINDS = new Set(["set_budget", "bid_strategy", "set_bid_strategy"]);
const BLOCKED_TEXT = /\bquebec\b|\bqu\u00e9bec\b|\bdemographic|\bage range|\bgender\b|\bhousehold income\b/i;

export type RuledSuggestion = Suggestion & { toddOnly?: boolean };

export function applyAdRules(suggestions: Suggestion[], ctx: { conversions: number }): { suggestions: RuledSuggestion[]; caveats: string[] } {
  const caveats: string[] = [];
  let out: RuledSuggestion[] = suggestions.filter((s) => !BLOCKED_TEXT.test(s.title + " " + s.rationale));
  if (ctx.conversions <= 0) {
    const before = out.length;
    out = out.filter((s) => s.kind !== "pause_campaign" && s.kind !== "pause_keyword");
    if (out.length !== before || before === 0) caveats.push("Google Ads has recorded no conversions in this window, so pause suggestions are held back until conversions are flowing.");
  }
  out = out.map((s) => TODD_ONLY_KINDS.has(s.kind) ? { ...s, toddOnly: true, title: s.title + " (Todd decides)" } : s);
  return { suggestions: out, caveats };
}

export function isToddOnlyAction(action: { type?: unknown } | null | undefined): boolean {
  return TODD_ONLY_KINDS.has(String(action?.type ?? ""));
}

export type Insight = { title: string; detail: string };
export function picturedInsights(input: {
  story?: { totals?: { clicks?: number; started?: number; submitted?: number; funded?: number } } | null;
  dropoff?: { steps?: Array<{ step: number; stopped: number; from_ad?: number }> } | null;
  health?: { checks?: Array<{ label: string; status: string; detail: string }> } | null;
}): Insight[] {
  const out: Insight[] = [];
  const t = input.story?.totals;
  if (t && Number(t.clicks ?? 0) > 0 && Number(t.submitted ?? 0) === 0) out.push({ title: "Ad clicks are not becoming submitted applications", detail: `${t.clicks} ad clicks, ${t.started ?? 0} applications started, none submitted. Look at where they stop before changing bids.` });
  const steps = [...(input.dropoff?.steps ?? [])].sort((a, b) => b.stopped - a.stopped);
  if (steps[0] && steps[0].stopped > 0) out.push({ title: `Most unfinished applications stop at Step ${steps[0].step}`, detail: `${steps[0].stopped} stopped there${steps[0].from_ad ? `, ${steps[0].from_ad} of them from ads` : ""}. Fixing that step is worth more than new keywords.` });
  for (const c of input.health?.checks ?? []) if (c.status === "fail") out.push({ title: `Google connection problem: ${c.label}`, detail: c.detail });
  return out.slice(0, 6);
}
