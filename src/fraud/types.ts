// BF_SERVER_v846_FRAUD - shared shapes for the fraud-detection suite.
//
// Every check answers with a CheckResult: a traffic-light status and plain-English reasons. A check never guesses:
// when the data or the outside service it needs is missing it says so (not_applicable / not_configured) instead of
// returning green.

/** The one database method the fraud code uses (a pg Pool or PoolClient, or a test double). */
export type Q = { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[]; rowCount?: number | null }> };

/** green = nothing found, amber = worth a look, red = strong sign of fraud. */
export type FraudStatus = "green" | "amber" | "red" | "not_configured" | "not_applicable" | "error";

export type ReasonSeverity = "info" | "amber" | "red";

export type Reason = {
  code: string;
  severity: ReasonSeverity;
  /** One plain-English sentence a broker can read out to a lender. */
  text: string;
};

export type CheckResult = {
  status: FraudStatus;
  reasons: Reason[];
  /** Small, non-personal numbers behind the result (counts, ratios). Never raw identifiers. */
  details?: Record<string, unknown>;
  /** Which outside service answered, when one did (e.g. "twilio_lookup", "rdap"). */
  provider?: string | null;
};

export const RANK: Record<FraudStatus, number> = {
  red: 5, amber: 4, error: 3, green: 2, not_configured: 1, not_applicable: 0,
};

/** The status that follows from a list of reasons: any red -> red, any amber -> amber, else green. */
export function statusFromReasons(reasons: Reason[]): "green" | "amber" | "red" {
  if (reasons.some((r) => r.severity === "red")) return "red";
  if (reasons.some((r) => r.severity === "amber")) return "amber";
  return "green";
}

export function result(reasons: Reason[], details?: Record<string, unknown>, provider?: string | null): CheckResult {
  return { status: statusFromReasons(reasons), reasons, ...(details ? { details } : {}), ...(provider ? { provider } : {}) };
}

export function notApplicable(text: string, details?: Record<string, unknown>): CheckResult {
  return { status: "not_applicable", reasons: [{ code: "not_applicable", severity: "info", text }], ...(details ? { details } : {}) };
}

export function notConfigured(text: string, provider?: string | null): CheckResult {
  return { status: "not_configured", reasons: [{ code: "not_configured", severity: "info", text }], provider: provider ?? null };
}

/** The worse of two statuses (for combining sub-checks). */
export function worse(a: FraudStatus, b: FraudStatus): FraudStatus {
  return RANK[a] >= RANK[b] ? a : b;
}

/** Combine several sub-results into one: reasons concatenated, status = the worst actionable one. */
export function combine(parts: CheckResult[], details?: Record<string, unknown>): CheckResult {
  const reasons = parts.flatMap((p) => p.reasons);
  const actionable = parts.filter((p) => p.status === "green" || p.status === "amber" || p.status === "red");
  let status: FraudStatus;
  if (actionable.length) status = actionable.map((p) => p.status).reduce(worse, "green");
  else if (parts.some((p) => p.status === "error")) status = "error";
  else if (parts.some((p) => p.status === "not_configured")) status = "not_configured";
  else status = "not_applicable";
  const providers = parts.map((p) => p.provider).filter((p): p is string => Boolean(p));
  return { status, reasons, details: { ...Object.assign({}, ...parts.map((p) => p.details ?? {})), ...(details ?? {}) }, provider: providers.length ? [...new Set(providers)].join(",") : null };
}
