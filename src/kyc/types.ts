// BF_SERVER_v872_KYC - shared shapes for ID and address verification (KYC).
//
// A provider runs the applicant's verification. Two exist:
//   onfido  Entrust IDV (formerly Onfido): a hosted flow (document photo + selfie liveness, plus whatever the
//           Studio workflow adds - identity record and address checks), results by signed webhook. Canada region by
//           default so data stays in Canada.
//   manual  no vendor: the applicant uploads ID (front and back) and a selfie in the client app and staff decide.
// Every provider answers in the same terms so the rest of Boreal never cares which one ran.

export const KYC_STATUSES = ["requested", "in_progress", "processing", "approved", "declined", "review", "expired", "cancelled", "error"] as const;
export type KycStatus = (typeof KYC_STATUSES)[number];

/** Statuses that end a verification (no more vendor work). */
export const FINAL_STATUSES: ReadonlySet<KycStatus> = new Set(["approved", "declined", "expired", "cancelled", "error"]);
/** Statuses that still need the applicant or the vendor. */
export const OPEN_STATUSES: ReadonlySet<KycStatus> = new Set(["requested", "in_progress", "processing"]);

export type KycProviderKey = "onfido" | "manual";

export type KycReason = { code: string; severity: "info" | "amber" | "red"; text: string };

/** Non-personal result per sub-check, e.g. { document: "clear", face: "clear", liveness: "consider", identity_record: "clear" }. */
export type KycChecks = Record<string, string>;

/** What the vendor read from the ID. Kept encrypted (pii_enc), never logged, shown to staff only on request. */
export type KycPii = {
  first_name?: string | null;
  last_name?: string | null;
  date_of_birth?: string | null;
  document_type?: string | null;
  document_number?: string | null;
  issuing_country?: string | null;
  issuing_state?: string | null;
  date_of_expiry?: string | null;
  address?: string | null;
};

export type KycPerson = {
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  phone: string | null;
  dob: string | null;
  address: { street: string | null; city: string | null; state: string | null; postcode: string | null; country: string | null } | null;
};

export type KycMedia = {
  kind: "document_front" | "document_back" | "document" | "selfie";
  vendorId: string;
  download: () => Promise<{ buffer: Buffer; contentType: string; filename: string } | null>;
};

export type KycResult = {
  status: KycStatus;
  reasons: KycReason[];
  checks: KycChecks;
  pii: KycPii | null;
  media: KycMedia[];
};

export type SessionResult =
  | { ok: true; vendorApplicantId: string | null; vendorSessionId: string; url: string; expiresAt: Date | null }
  | { ok: false; error: string };

export type WebhookEvent = { eventKey: string; vendorSessionId: string | null; action: string };

export interface KycProvider {
  readonly key: KycProviderKey;
  readonly label: string;
  /** true when this provider runs a hosted vendor flow; false for manual uploads. */
  readonly hosted: boolean;
  configured(): boolean;
  /** Settings the provider needs (shown to Admins; names only, never values). */
  readonly settings: string[];
  createSession?(input: { verificationId: string; person: KycPerson; redirectUrl: string }): Promise<SessionResult>;
  /** Checks the webhook really came from the vendor, over the exact bytes received. */
  verifyWebhook?(rawBody: Buffer, headers: Record<string, unknown>): boolean;
  parseWebhook?(body: unknown, rawBody: Buffer): WebhookEvent | null;
  /** The vendor's current answer for a session (the webhook only says "something changed"). */
  fetchResult?(vendorSessionId: string, vendorApplicantId: string | null): Promise<{ ok: true; result: KycResult } | { ok: false; error: string }>;
}

export function isKycStatus(v: unknown): v is KycStatus {
  return typeof v === "string" && (KYC_STATUSES as readonly string[]).includes(v);
}
