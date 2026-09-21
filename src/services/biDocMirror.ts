// BF_SERVER_BLOCK_v215_BF_TO_BI_DOC_MIRROR_v1
// Mirrors a BF document to the linked BI application. Called
// fire-and-forget from the BF client doc-upload handler. Service
// JWT signed with the shared JWT_SECRET (decision A1).
import jwt from "jsonwebtoken";
import { pool } from "../db.js";
import { logError, logInfo } from "../observability/logger.js";

const BI_SERVER_URL =
  process.env.BI_SERVER_URL
  || "https://bi-server-cse0apamgkheb9d5.canadacentral-01.azurewebsites.net";

function getSecret(): string {
  return process.env.JWT_SECRET || "";
}

function mintServiceJwt(): string {
  return jwt.sign(
    { kind: "service", source: "bf-server" },
    getSecret(),
    { expiresIn: "5m" },
  );
}

export type MirrorInput = {
  bfApplicationId: string;
  bfDocumentId: string;
  documentType: string | null;
  fileName: string | null;
  mimeType: string | null;
  fileSize: number | null;
  storageUrl: string | null;
  uploadedByName: string | null;
};

export type MirrorResult =
  | { ok: true; biDocumentId: string; biApplicationId: string; idempotent?: boolean }
  | { ok: false; error: string };

// Resolve the BI public_id for a BF application. Returns null if
// no BI link exists (i.e. the applicant did not opt into PGI).
export async function resolveBiPublicId(bfApplicationId: string): Promise<string | null> {
  const r = await pool.query<{ bi_public_id: string | null }>(
    `SELECT bi_public_id FROM applications WHERE id::text = $1 LIMIT 1`,
    [bfApplicationId],
  );
  return r.rows[0]?.bi_public_id ?? null;
}


// BF_SERVER_PGI_MIRROR_VOCAB_v1
// Map BF upload categories onto active bi_required_doc_catalog vocabulary.
export const BF_TO_PGI_DOC_TYPE: Record<string, string> = {
  signed_term_sheet: "loan_agreement",
  loan_agreement: "loan_agreement",
  term_sheet: "loan_agreement",
  pnl_interim: "profit_loss",
  profit_loss: "profit_loss",
  balance_sheet_interim: "balance_sheet",
  balance_sheet: "balance_sheet",
  ar: "ar_aging",
  ar_aging: "ar_aging",
  accounts_receivable_aging: "ar_aging",
  ap: "ap_aging",
  ap_aging: "ap_aging",
  accounts_payable_aging: "ap_aging",
  // BF_SERVER_PGI_MIRROR_LABELS_v357 - the display labels documents are actually
  // filed under ("A/P", "PnL – Interim financials"), normalized by pgiDocTypeFor.
  // Only the snake_case codes above were listed, so real uploads never mirrored.
  pnl_interim_financials: "profit_loss",
  p_l_interim_financials: "profit_loss",
  profit_and_loss: "profit_loss",
  balance_sheet_interim_financials: "balance_sheet",
  a_r: "ar_aging",
  accounts_receivable: "ar_aging",
  a_p: "ap_aging",
  accounts_payable: "ap_aging",
  founder_cv: "founder_cv",
  financial_forecast: "financial_forecast",
};

export function pgiDocTypeFor(category: string | null | undefined): string | null {
  // BF_SERVER_PGI_MIRROR_LABELS_v357 - "A/R" -> "a_r", "PnL – Interim financials" -> "pnl_interim_financials".
  const c = String(category ?? "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return c ? BF_TO_PGI_DOC_TYPE[c] ?? null : null;
}

export function shouldMirrorToPgi(category: string | null | undefined): boolean {
  return pgiDocTypeFor(category) !== null;
}

export async function mirrorDocToBi(input: MirrorInput): Promise<MirrorResult> {
  const secret = getSecret();
  if (!secret) return { ok: false, error: "no_jwt_secret" };

  const publicId = await resolveBiPublicId(input.bfApplicationId);
  if (!publicId) return { ok: false, error: "no_bi_link" };

  const url = `${BI_SERVER_URL.replace(/\/+$/, "")}/api/v1/bi/applications/${encodeURIComponent(publicId)}/documents/from-bf`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${mintServiceJwt()}`,
      },
      body: JSON.stringify({
        bf_application_id: input.bfApplicationId,
        bf_document_id: input.bfDocumentId,
        document_type: pgiDocTypeFor(input.documentType) ?? input.documentType,
        bf_document_type: input.documentType,
        file_name: input.fileName,
        mime_type: input.mimeType,
        file_size: input.fileSize,
        storage_url: input.storageUrl,
        uploaded_by_name: input.uploadedByName,
      }),
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (!r.ok) {
      const text = await r.text().catch(() => "");
      // BF_SERVER_OCR_RATE_LIMIT_v1 - bi-server answers 500 with a unique-index
      // violation when the document is already mirrored. The document IS in BI,
      // so this is not an incident: log it as such rather than as an error, and
      // return a distinct code so callers can tell "already there" from a real
      // mirror failure. The success shape carries a bi_document_id we do not
      // have here, which is why this stays on the failure branch.
      if (text.includes("idx_bi_documents_app_doctype_unique") || text.includes("duplicate key value")) {
        logInfo("bi_doc_mirror_already_present", {
          bfApplicationId: input.bfApplicationId,
          bfDocumentId: input.bfDocumentId,
          documentType: input.documentType,
        });
        return { ok: false, error: "bi_already_mirrored" };
      }
      logError("bi_doc_mirror_http_error", {
        code: "bi_doc_mirror_http_error",
        status: r.status,
        body: text.slice(0, 500),
      });
      return { ok: false, error: `bi_${r.status}` };
    }
    const j: any = await r.json().catch(() => ({}));
    if (!j?.ok || !j?.bi_document_id) {
      return { ok: false, error: "bi_bad_response" };
    }
    logInfo("bi_doc_mirror_success", {
      bfApplicationId: input.bfApplicationId,
      bfDocumentId: input.bfDocumentId,
      biDocumentId: j.bi_document_id,
      idempotent: !!j.idempotent,
    });
    return {
      ok: true,
      biDocumentId: String(j.bi_document_id),
      biApplicationId: String(j.bi_application_id ?? ""),
      idempotent: !!j.idempotent,
    };
  } catch (err: any) {
    clearTimeout(timeout);
    logError("bi_doc_mirror_exception", {
      code: "bi_doc_mirror_exception",
      error: err?.message ?? "unknown",
    });
    return { ok: false, error: "bi_exception" };
  }
}

// Fire-and-forget wrapper. Never throws. Use this from request
// handlers so the user response is not delayed.
export function mirrorDocToBiAsync(input: MirrorInput): void {
  // BF_SERVER_PGI_MIRROR_SCOPE_v1 - scope enforced here, not at the call sites,
  // so a future caller cannot forget it.
  if (!shouldMirrorToPgi(input.documentType)) return;
  void mirrorDocToBi(input).then((r) => {
    // BF_SERVER_PGI_MIRROR_LABELS_v357 - a skipped mirror (no linked BI application,
    // missing secret) was invisible. Say why, so a missing BI document can be traced.
    if (!r.ok && r.error !== "bi_already_mirrored") {
      logInfo("bi_doc_mirror_skipped", {
        bfApplicationId: input.bfApplicationId,
        bfDocumentId: input.bfDocumentId,
        documentType: input.documentType,
        reason: r.error,
      });
    }
  }).catch((err) => {
    logError("bi_doc_mirror_unhandled", {
      code: "bi_doc_mirror_unhandled",
      error: err?.message ?? "unknown",
    });
  });
}

// BF_SERVER_PGI_MIRROR_LABELS_v357 - catch-up for documents uploaded before their
// labels were recognised, or before the BF application was linked to BI. BI-Server
// dedupes on the BF document, so re-running is harmless.
export async function backfillPgiMirrors(days = 30): Promise<{ eligible: number; mirrored: number }> {
  const r = await pool.query<{
    id: string; application_id: string; category: string | null;
    filename: string | null; size_bytes: number | null; blob_url: string | null;
  }>(
    `SELECT d.id::text AS id, d.application_id::text AS application_id,
            COALESCE(d.category, d.document_type) AS category,
            d.filename, d.size_bytes, d.blob_url
       FROM documents d
       JOIN applications a ON a.id::text = d.application_id::text
      WHERE a.bi_public_id IS NOT NULL
        AND COALESCE(d.status, '') <> 'rejected'
        AND d.created_at >= now() - ($1 || ' days')::interval
      ORDER BY d.created_at
      LIMIT 500`,
    [String(days)],
  );
  let eligible = 0;
  let mirrored = 0;
  for (const row of r.rows) {
    if (!shouldMirrorToPgi(row.category)) continue;
    eligible += 1;
    const res = await mirrorDocToBi({
      bfApplicationId: row.application_id,
      bfDocumentId: row.id,
      documentType: row.category,
      fileName: row.filename,
      mimeType: null,
      fileSize: typeof row.size_bytes === "number" ? row.size_bytes : null,
      storageUrl: row.blob_url,
      uploadedByName: null,
    });
    if (res.ok) mirrored += 1;
  }
  logInfo("bi_doc_mirror_backfill", { eligible, mirrored });
  return { eligible, mirrored };
}


// BF_SERVER_MOVE_WITHDRAW_v395 - a document moved OUT of a category PGI uses
// (an A/R report re-filed as "Other") leaves a wrong copy in BI. Ask BI to retire
// it (BI-Server v394). BI keeps a copy its staff already accepted.
export async function withdrawDocFromBi(bfApplicationId: string, bfDocumentId: string): Promise<{ ok: boolean; error?: string; withdrawn?: number; keptAccepted?: boolean }> {
  const secret = getSecret();
  if (!secret) return { ok: false, error: "no_jwt_secret" };
  const publicId = await resolveBiPublicId(bfApplicationId);
  if (!publicId) return { ok: false, error: "no_bi_link" };
  const url = `${BI_SERVER_URL.replace(/\/+$/, "")}/api/v1/bi/applications/${encodeURIComponent(publicId)}/documents/from-bf/withdraw`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${mintServiceJwt()}` },
      body: JSON.stringify({ bf_document_id: bfDocumentId }),
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (!r.ok) return { ok: false, error: `bi_${r.status}` };
    const j: any = await r.json().catch(() => ({}));
    return { ok: Boolean(j?.ok), withdrawn: Number(j?.withdrawn ?? 0), keptAccepted: Boolean(j?.kept_accepted) };
  } catch (err: any) {
    clearTimeout(timeout);
    return { ok: false, error: "bi_exception" };
  }
}

/** Fire-and-forget: only when the document LEFT a PGI category for one that is not. */
export function withdrawDocFromBiAsync(bfApplicationId: string, bfDocumentId: string, from: string | null, to: string | null): void {
  if (!shouldMirrorToPgi(from) || shouldMirrorToPgi(to)) return;
  void withdrawDocFromBi(bfApplicationId, bfDocumentId).then((r) => {
    logInfo("bi_doc_withdraw", { bfApplicationId, bfDocumentId, from, to, ...r });
  }).catch((err) => {
    logError("bi_doc_withdraw_unhandled", { code: "bi_doc_withdraw_unhandled", error: err?.message ?? "unknown" });
  });
}
