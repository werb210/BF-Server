// BF_SERVER_OCR_QUOTA_v47
// Tell an infrastructure failure apart from a bad upload.

export type OcrFailureKind = "quota" | "auth" | "throttled" | "unavailable" | "config" | "other";

const PATTERNS: Array<{ kind: OcrFailureKind; re: RegExp }> = [
  { kind: "quota", re: /out of call volume quota|call volume quota|free tier|f0 pricing tier|quota exceeded/i },
  { kind: "config", re: /AZURE_DOC_INTEL_(ENDPOINT|KEY)\s+not set|not configured/i },
  { kind: "auth", re: /\b401\b|invalid subscription key|access denied|unauthorized|rejected our credentials/i },
  { kind: "throttled", re: /\b429\b|too many requests|rate limit/i },
  { kind: "unavailable", re: /\b50[0234]\b|service unavailable|unreachable|timeout|ETIMEDOUT|ECONNRESET|EAI_AGAIN/i },
];

export function classifyOcrFailure(message: string | null | undefined): OcrFailureKind {
  const m = String(message ?? "");
  if (!m.trim()) return "other";
  for (const p of PATTERNS) if (p.re.test(m)) return p.kind;
  return "other";
}

// Our problem, not the applicant's: never count these toward the auto-skip
// threshold, and never tell staff the uploads look wrong.
const INFRASTRUCTURE: ReadonlySet<OcrFailureKind> = new Set<OcrFailureKind>([
  "quota", "auth", "throttled", "unavailable", "config",
]);

export function isInfrastructureFailure(kind: OcrFailureKind): boolean {
  return INFRASTRUCTURE.has(kind);
}

export function anyInfrastructureFailure(messages: Array<string | null | undefined>): boolean {
  return messages.some((m) => isInfrastructureFailure(classifyOcrFailure(m)));
}

export function describeOcrFailure(kind: OcrFailureKind, raw: string): string {
  switch (kind) {
    case "quota":
      return "Azure Document Intelligence has run out of quota on its current pricing tier, so no statement could be read. This is an account limit, not a problem with the uploaded documents. Upgrade the Document Intelligence resource to a paid tier, then re-run the analysis.";
    case "config":
      return "Azure Document Intelligence is not configured. Set AZURE_DOC_INTEL_ENDPOINT and AZURE_DOC_INTEL_KEY on the BF-Server App Service.";
    case "auth":
      return "Azure Document Intelligence rejected our credentials, so no statement could be read. Check the Document Intelligence key on the BF-Server App Service.";
    case "throttled":
      return "Azure Document Intelligence is rate limiting our requests. The analysis will be retried automatically.";
    case "unavailable":
      return "Azure Document Intelligence was unreachable. The analysis will be retried automatically.";
    default:
      return raw;
  }
}
