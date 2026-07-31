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
        document_type: input.documentType,
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
  void mirrorDocToBi(input).catch((err) => {
    logError("bi_doc_mirror_unhandled", {
      code: "bi_doc_mirror_unhandled",
      error: err?.message ?? "unknown",
    });
  });
}
