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
  return { score: s, band: band(s), reasons: reasons.slice(0, 12), covered, not_covered: notCovered };
}

/** Plain-text pre-screen summary for the lender package. */
export function prescreenText(s: FraudScore, opts: { company: string; applicationName: string | null; at: Date }): string[] {
  const date = opts.at.toISOString().slice(0, 10);
  const lines = [
    `Fraud pre-screen - ${opts.applicationName ?? "application"}`,
    `Prepared by ${opts.company} on ${date}`,
    "",
    `Fraud score: ${s.score} / 100 (${BAND_TEXT[s.band]})`,
    "",
    "Checks completed:",
    ...(s.covered.length ? s.covered.map((c) => `  - ${c.label}: ${c.status === "green" ? "no concerns" : c.status === "amber" ? "worth a look" : "concern found"}`) : ["  (none yet)"]),
    "",
  ];
  if (s.reasons.length) lines.push("Items needing attention:", ...s.reasons.map((r) => `  - [${r.severity === "red" ? "Concern" : "Review"}] ${r.text}`), "");
  if (s.not_covered.length) lines.push("Not covered by this pre-screen:", ...s.not_covered.map((c) => `  - ${c.label}: ${c.why}`), "");
  lines.push("This pre-screen lists signs worth reviewing. It is not a finding of fraud and does not replace the lender's own checks.");
  return lines;
}

export function scoreCheckLabel(key: FraudCheckKey): string {
  return fraudCheck(key)?.label ?? key;
}
