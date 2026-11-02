// BF_SERVER_v846_FRAUD - check 16: one fraud score per application (0 = nothing found, 100 = very likely fraud) with the
// reasons behind it, and the "pre-screened" summary a broker can add to the lender package.
//
// Each check adds its weight for a red or amber result (src/fraud/catalogue.ts). Per-document checks count once at
// their worst result, plus 5 for each further red document (up to 15). The score is capped at 100. Checks that could
// not run are listed as "not covered" - they never lower the score.
import { FRAUD_CHECKS, fraudCheck, type FraudCheckKey } from "./catalogue.js";
import { RANK, type FraudStatus, type Reason } from "./types.js";

export type StoredResult = { check_key: string; subject: string; status: FraudStatus; reasons: Reason[] };

export type ScoreBand = "low" | "medium" | "high";

export type FraudScore = {
  score: number;
  band: ScoreBand;
  reasons: Array<{ check: string; label: string; severity: "red" | "amber"; text: string }>;
  covered: Array<{ check: string; label: string; status: FraudStatus }>;
  not_covered: Array<{ check: string; label: string; status: FraudStatus; why: string }>;
  // BF_SERVER_v885_FRAUD_TEXT - how many checks the score rests on, so "0 / 100" is never read as a full check.
  checks_run: number;
  checks_total: number;
  summary: string;
};

export function band(score: number): ScoreBand {
  return score >= 50 ? "high" : score >= 20 ? "medium" : "low";
}

export const BAND_TEXT: Record<ScoreBand, string> = { low: "low risk", medium: "needs a closer look", high: "high risk" };

export function computeScore(results: StoredResult[], allowed: ReadonlySet<string>): FraudScore {
  let score = 0;
  const reasons: FraudScore["reasons"] = [];
  const covered: FraudScore["covered"] = [];
  const notCovered: FraudScore["not_covered"] = [];
  for (const def of FRAUD_CHECKS) {
    if (def.key === "fraud_16" || !allowed.has(def.key)) continue;
    const rows = results.filter((r) => r.check_key === def.key);
    if (!rows.length) { notCovered.push({ check: def.key, label: def.label, status: "not_applicable", why: "not run yet" }); continue; }
    const worst = rows.map((r) => r.status).reduce((a, b) => (RANK[a] >= RANK[b] ? a : b));
    if (worst === "red") {
      score += def.weight.red + Math.min(15, 5 * (rows.filter((r) => r.status === "red").length - 1));
    } else if (worst === "amber") {
      score += def.weight.amber;
    }
    if (worst === "red" || worst === "amber" || worst === "green") covered.push({ check: def.key, label: def.label, status: worst });
    else {
      const why = rows.find((r) => r.status === worst)?.reasons[0]?.text ?? (worst === "not_configured" ? "not set up" : "no data");
      notCovered.push({ check: def.key, label: def.label, status: worst, why });
    }
    for (const r of rows) {
      for (const reason of r.reasons) {
        if (reason.severity === "red" || reason.severity === "amber") reasons.push({ check: def.key, label: def.label, severity: reason.severity, text: reason.text });
      }
    }
  }
  reasons.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === "red" ? -1 : 1));
  const s = Math.min(100, Math.round(score));
  const total = covered.length + notCovered.length;
  const summary = `${s} / 100 (${BAND_TEXT[band(s)]}), based on ${covered.length} of ${total} checks`
    + (notCovered.length ? `; ${notCovered.length} could not run yet, so a low score does not clear the file.` : ".");
  return { score: s, band: band(s), reasons: reasons.slice(0, 12), covered, not_covered: notCovered, checks_run: covered.length, checks_total: total, summary };
}

// BF_SERVER_v885_FRAUD_TEXT - the pre-screen goes to lenders. It never carries Boreal's internal checks on its
// own staff (inside-job alerts) or the reasons a check did not run, which are written for Boreal staff
// ("An Admin can turn it on in Settings -> Fraud protection"). Lenders see only that the check was not covered.
export const INTERNAL_ONLY_CHECKS: ReadonlySet<string> = new Set(["fraud_14"]);
function lenderWhy(status: FraudStatus, why: string): string {
  if (why === "not run yet") return "not run yet";
  if (status === "not_configured") return "not available for this file";
  if (status === "error") return "could not be completed";
  return "no information available yet";
}

/** Plain-text pre-screen summary for the lender package. */
export function prescreenText(s: FraudScore, opts: { company: string; applicationName: string | null; at: Date }): string[] {
  const date = opts.at.toISOString().slice(0, 10);
  const covered = s.covered.filter((c) => !INTERNAL_ONLY_CHECKS.has(c.check));
  const notCovered = s.not_covered.filter((c) => !INTERNAL_ONLY_CHECKS.has(c.check));
  const reasons = s.reasons.filter((r) => !INTERNAL_ONLY_CHECKS.has(r.check));
  const total = covered.length + notCovered.length;
  const lines = [
    `Fraud pre-screen - ${opts.applicationName ?? "application"}`,
    `Prepared by ${opts.company} on ${date}`,
    "",
    `Fraud score: ${s.score} / 100 (${BAND_TEXT[s.band]}), based on ${covered.length} of ${total} checks`,
    ...(notCovered.length ? [`${notCovered.length} check(s) could not run yet, so this score is not a complete screen.`] : []),
    "",
    "Checks completed:",
    ...(covered.length ? covered.map((c) => `  - ${c.label}: ${c.status === "green" ? "no concerns" : c.status === "amber" ? "worth a look" : "concern found"}`) : ["  (none yet)"]),
    "",
  ];
  if (reasons.length) lines.push("Items needing attention:", ...reasons.map((r) => `  - [${r.severity === "red" ? "Concern" : "Review"}] ${r.text}`), "");
  if (notCovered.length) lines.push("Not covered by this pre-screen:", ...notCovered.map((c) => `  - ${c.label}: ${lenderWhy(c.status, c.why)}`), "");
  lines.push("This pre-screen lists signs worth reviewing. It is not a finding of fraud and does not replace the lender's own checks.");
  return lines;
}

export function scoreCheckLabel(key: FraudCheckKey): string {
  return fraudCheck(key)?.label ?? key;
}
