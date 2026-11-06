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
  // BF_SERVER_v906_FRAUD_FLOOR - false while checks are queued or documents still wait for their tamper scan: the
  // number is not final then and the tab says "Checks still running" instead of showing it as the score.
  complete?: boolean;
  pending_reason?: string | null;
  floor?: { applied: boolean; reason: string | null };
};

// BF_SERVER_v906_FRAUD_FLOOR - a file with tampered bank statements scored 45 on its first run (before every tamper
// scan was in) and 85 after "Run again". A confirmed tamper finding (red) on a bank statement now holds the score in
// High risk on every run, whatever else has or has not run yet.
export const TAMPER_FLOOR = 75;
export type ScoreOptions = { bankStatementIds?: ReadonlySet<string>; queued?: boolean; pendingDocuments?: number };

/** The documents filed as bank statements (category or type mentions "bank"). */
export function bankStatementIds(docs: Array<{ id: string; category: string | null }>): Set<string> {
  return new Set(docs.filter((d) => /bank/i.test(String(d.category ?? "")) && !/void|cheque|check|pad\b/i.test(String(d.category ?? ""))).map((d) => String(d.id)));
}

export function band(score: number): ScoreBand {
  return score >= 50 ? "high" : score >= 20 ? "medium" : "low";
}

export const BAND_TEXT: Record<ScoreBand, string> = { low: "low risk", medium: "needs a closer look", high: "high risk" };

export function computeScore(results: StoredResult[], allowed: ReadonlySet<string>, opts: ScoreOptions = {}): FraudScore {
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
  let s = Math.min(100, Math.round(score));
  // BF_SERVER_v906_FRAUD_FLOOR
  const tamperedStatement = opts.bankStatementIds && allowed.has("fraud_1")
    ? results.find((r) => r.check_key === "fraud_1" && r.status === "red" && opts.bankStatementIds!.has(r.subject))
    : undefined;
  let floorReason: string | null = null;
  if (tamperedStatement) {
    floorReason = "A bank statement shows signs of editing (document tamper scan), so this file is High risk until a person reviews the statements.";
    if (s < TAMPER_FLOOR) s = TAMPER_FLOOR;
    reasons.unshift({ check: "fraud_1", label: scoreCheckLabel("fraud_1"), severity: "red", text: floorReason });
  }
  const pendingDocs = Math.max(0, Number(opts.pendingDocuments ?? 0));
  const pendingReason = opts.queued ? "Checks are still running. The score will be final when they finish."
    : pendingDocs > 0 ? `${pendingDocs} document(s) are still waiting for their tamper scan. The score will be final when they are scanned.`
    : null;
  const total = covered.length + notCovered.length;
  const summary = `${s} / 100 (${BAND_TEXT[band(s)]}), based on ${covered.length} of ${total} checks`
    + (notCovered.length ? `; ${notCovered.length} could not run yet, so a low score does not clear the file.` : ".");
  return {
    score: s, band: band(s), reasons: reasons.slice(0, 12), covered, not_covered: notCovered, checks_run: covered.length, checks_total: total, summary,
    complete: !pendingReason, pending_reason: pendingReason, floor: { applied: Boolean(tamperedStatement), reason: floorReason },
  };
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
