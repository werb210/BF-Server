// BF_SERVER_v873_LENDER_API - the per-lender connector contract.
//
// A connector knows how to talk to one lender's broker API (or one family of APIs: the generic REST/JSON connector is
// configured per lender by field mapping). Every connector answers the same five questions:
//   submitApplication  send the lender package; returns the lender's id for the deal
//   fetchStatus        read the deal back: status, offers, conditions / document requests, funding (polling)
//   uploadDocument     send one more document to a deal already at the lender
//   parseWebhook       turn a lender's webhook body into the same shape fetchStatus returns (the signature is checked
//                      before this is called, by src/lenderConnectors/webhook.ts)
//   testConnection     a harmless call that proves the credentials work
// A connector that cannot do one of these says so in `capabilities`; nothing is ever faked. A connector whose API has
// not been published to us yet (Merchant Growth today) has availability "awaiting_lender_api_docs": it can be set up
// and its credentials stored, but it never sends anything, and the lender keeps getting the package by email.
import type { HttpClient } from "./http.js";

export type ConnectorKind = "generic_rest" | "salesforce" | "heron" | "merchant_growth";

/** Where a lender's deal is, in Boreal's words. Each lender's own status names map onto these. */
export const LENDER_BUCKETS = [
  "submitted", "in_review", "documents_requested", "offer", "closing", "funded", "declined", "withdrawn", "unknown",
] as const;
export type LenderBucket = (typeof LENDER_BUCKETS)[number];

export const BUCKET_LABELS: Record<LenderBucket, string> = {
  submitted: "Submitted",
  in_review: "In review",
  documents_requested: "Documents requested",
  offer: "Offer",
  closing: "Offer accepted, closing",
  funded: "Funded",
  declined: "Declined",
  withdrawn: "Withdrawn",
  unknown: "Status not recognised",
};

/** A status the lender is done with. */
export function isTerminalBucket(b: LenderBucket | null | undefined): boolean {
  return b === "funded" || b === "declined" || b === "withdrawn";
}

/**
 * Polling stops only for a declined or withdrawn deal. A funded deal keeps being polled (once a day at most) so the
 * lender can report the outstanding balance onto the file's Active Contract, until that contract is closed.
 */
export function stopsPolling(b: LenderBucket | null | undefined): boolean {
  return b === "declined" || b === "withdrawn";
}

/** How often a funded deal is polled for its balance: the connection's interval, but not more than once a day. */
export const FUNDED_POLL_MINUTES = 1440;

export type PackageAttachment = { filename: string; contentType: string; category: string; content: Buffer };

/** Everything a connector may send for one application to one lender. */
export type LenderPackage = {
  applicationId: string;
  lenderId: string;
  lenderName: string;
  /** Normalised values (see mapping.ts SOURCE_KEYS) plus every package field as "field:<label>". */
  values: Record<string, string | number | boolean | null>;
  attachments: PackageAttachment[];
  submittedAt: string;
};

export type ConnectorContext = {
  /** The connection's non-secret settings (JSON, editable by the Admin). */
  config: Record<string, unknown>;
  /** Decrypted credentials. Never logged, never returned to the browser. */
  secrets: Record<string, string>;
  http: HttpClient;
};

export type SubmitResult =
  | { ok: true; externalId: string | null; status: string | null; detail?: string | null; warnings?: string[] }
  | { ok: false; error: string; retryable: boolean; httpStatus?: number | null };

export type RemoteOffer = {
  externalId: string;
  amount: number | null;
  rateFactor: string | null;
  term: string | null;
  paymentFrequency: string | null;
  expiryDate: string | null;
  status: string | null;
  notes: string | null;
};

export type RemoteCondition = {
  externalId: string;
  kind: "condition" | "document_request";
  description: string;
  documentType: string | null;
  status: "open" | "satisfied" | "waived";
};

/** What the lender says about one deal, from a poll or a webhook. Fields left undefined were not reported. */
export type RemoteUpdate = {
  externalId: string;
  status?: string | null;
  statusLabel?: string | null;
  offers?: RemoteOffer[];
  conditions?: RemoteCondition[];
  fundedAmount?: number | null;
  commissionAmount?: number | null;
  /** The outstanding balance the lender reports on a funded deal, and the date it is as of (YYYY-MM-DD; today when
   *  the lender does not say). Recorded on the file's Active Contract as a lender-reported balance. */
  balance?: number | null;
  balanceAsOf?: string | null;
  note?: string | null;
  /** The lender record that now carries the status when it is not the one we created (a converted Salesforce lead's
   *  opportunity). Pushes about that record are matched to this deal. */
  linkedRecordId?: string | null;
};

export type FetchResult = { ok: true; update: RemoteUpdate } | { ok: false; error: string; retryable: boolean };
export type UploadResult = { ok: true; detail?: string | null } | { ok: false; error: string; retryable: boolean };

export type ConnectorCapabilities = { submit: boolean; status: boolean; upload: boolean; webhook: boolean };

export type SecretField = { key: string; label: string; required: boolean; help?: string };

export type LenderConnector = {
  kind: ConnectorKind;
  label: string;
  description: string;
  capabilities: ConnectorCapabilities;
  /** "available", or "awaiting_lender_api_docs" while the lender has not given us its API documentation. */
  availability: "available" | "awaiting_lender_api_docs";
  secretFields: SecretField[];
  /** Checks the Admin's settings before they are saved; returns plain-English problems. */
  validateConfig(config: Record<string, unknown>): string[];
  /** The lender status -> bucket map this connector starts with (an Admin can override any entry). */
  defaultStatusMap(config: Record<string, unknown>): Record<string, LenderBucket>;
  submitApplication(ctx: ConnectorContext, pkg: LenderPackage): Promise<SubmitResult>;
  fetchStatus?(ctx: ConnectorContext, externalId: string): Promise<FetchResult>;
  uploadDocument?(ctx: ConnectorContext, externalId: string, doc: PackageAttachment): Promise<UploadResult>;
  parseWebhook?(config: Record<string, unknown>, body: unknown): RemoteUpdate[];
  testConnection?(ctx: ConnectorContext): Promise<{ ok: boolean; message: string }>;
};

export const AWAITING_DOCS_ERROR = "awaiting_lender_api_docs";
