// BF_SERVER_v74_BLOCK_1_7 — pick the right submission adapter per lender
// and record the result in application_packages.
import type { Pool } from "pg";
import { sendLenderEmail } from "../../modules/lenderSubmissions/adapters/EmailAdapter.js";
import { resolveOwnerSignatureHtml } from "../email/resolveSignature.js"; // v693
import { buildApplicationPackage } from "./buildApplicationPackage.js";
import { loadPackageInputs } from "./loadPackageInputs.js"; // BF_SERVER_v76_BLOCK_1_9

// No shared decrypt helper exists yet in this codebase for lender API keys;
// treat api_key_encrypted as plaintext fallback until encryption utility is added.
const decryptSecret = async (value: string): Promise<string> => value;

// v_DISPATCH_LAZY_GOOGLE_ADAPTER_v1 — lazy-load the Google Sheet adapter only
// when a google_sheet lender is dispatched. Removing the module-level
// `await import` keeps this module synchronous (so unit-test module mocks wire in
// before evaluation) and avoids loading googleapis on every dispatch.
async function loadGoogleAdapter(): Promise<any> {
  try {
    const mod = await import("../../modules/submissions/adapters/GoogleSheetSubmissionAdapter.js");
    return mod.GoogleSheetSubmissionAdapter;
  } catch (err) {
    console.warn("[dispatch] google adapter unavailable", err);
    return null;
  }
}

export type DispatchLender = {
  lender_id: string;
  name: string;
  submission_method: string | null;
  submission_email: string | null;
  api_endpoint: string | null;
  api_key_encrypted: string | null;
  google_sheet_id: string | null;
  google_sheet_tab?: string | null;
};

export type DispatchCtx = {
  pool: Pool;
  applicationId: string;
};

export async function dispatchToSelected(
  ctx: DispatchCtx,
  lenders: DispatchLender[],
  // v_DISPATCH_LAZY_GOOGLE_ADAPTER_v1 — optional injection seam so the Google
  // Sheet adapter loader can be stubbed in unit tests (the real lazy import is
  // not interceptable by module mocks). Production callers pass two args.
  deps: { loadGoogleAdapter?: () => Promise<any> } = {}
): Promise<string[]> {
  let signedApp: Buffer | null = null;
  let creditSummary: Buffer | null = null;
  let docs: { category: string; files: { filename: string; content: Buffer }[] }[] = [];
  let additionalSignedDocs: { filename: string; content: Buffer }[] = []; // v_ACCORD_PACKAGE_ROOT_v1
  type FieldRow = { label: string; value: string | number | boolean | null };
  let fields: FieldRow[] = [];

  try {
    // BF_SERVER_v76_BLOCK_1_9 — real loader (was a dynamic-import fallback in 1.7)
    const inp = await loadPackageInputs(ctx);
    signedApp = inp.signedApplicationPdf ?? null;
    creditSummary = inp.creditSummaryPdf ?? null;
    docs = inp.documents ?? [];
    additionalSignedDocs = inp.additionalSignedDocs ?? [];
    fields = inp.fields ?? [];
  } catch (e) {
    // best-effort: leave fallbacks (null/[]) in place; do not block dispatch
    console.warn("[dispatch] loadPackageInputs failed", e);
  }

  // BF_SERVER_LENDER_QA_EXPORT_v1 -- attach finalized Q&A export(s) to the
  // lender package (flows into both the email zip and the API attachments).
  try {
    const { buildFinalizedQaExports } = await import("./qaExport.js");
    const qaPdfs = await buildFinalizedQaExports(ctx.applicationId);
    if (qaPdfs.length) additionalSignedDocs = [...additionalSignedDocs, ...qaPdfs];
  } catch (e) {
    console.warn("[dispatch] qa export attach failed", e instanceof Error ? e.message : String(e));
  }

  // Never email a package without the real signed application. If the signed PDF
  // could not be loaded, fail loudly so the worker retries instead of sending an
  // unsigned (or fabricated) document to a lender.
  if (!signedApp) {
    throw new Error("signed_application_pdf_missing");
  }

  const pkg = await buildApplicationPackage({
    applicationId: ctx.applicationId,
    signedApplicationPdf: signedApp,
    additionalSignedDocs,
    creditSummaryPdf: creditSummary,
    fields,
    documents: docs.map((g) => ({
      category: g.category,
      files: g.files.map((f) => ({ filename: f.filename, content: f.content })),
    })),
  });

  const sent: string[] = [];
  for (const l of lenders) {
    const method = (l.submission_method ?? "email").toLowerCase();
    let ok = false;
    let error: string | null = null;
    let deliveredTo: string | null = null;

    if (method === "email") {
      const __ownerSigHtml = await resolveOwnerSignatureHtml(ctx.pool, ctx.applicationId); // v693
      const r = await sendLenderEmail({
        lender: { id: l.lender_id, name: l.name, submission_email: l.submission_email },
        subject: `Application package — ${l.name}`,
        bodyText: `Application ${ctx.applicationId} package attached.`,
        attachments: [{ filename: `application-${ctx.applicationId}.zip`, contentType: "application/zip", content: pkg.zipBuffer }],
        signatureHtml: __ownerSigHtml,
      });
      ok = r.ok;
      if (r.ok) deliveredTo = r.deliveredTo;
      else error = r.error;
    } else if (method === "api") {
      const endpoint = (l.api_endpoint ?? "").trim();
      if (!endpoint) {
        error = "missing_api_endpoint";
      } else {
        const headers: Record<string, string> = {
          "Content-Type": "application/json",
          "Accept": "application/json",
          "User-Agent": "BorealFinancial/1.0",
        };
        if (l.api_key_encrypted) {
          try {
            const apiKey = await decryptSecret(l.api_key_encrypted).catch(() => l.api_key_encrypted);
            headers["Authorization"] = `Bearer ${apiKey}`;
          } catch {
            // fall through; lender will get an unauthorized response which we'll record
          }
        }
        const body = {
          applicationId: ctx.applicationId,
          lenderId: l.lender_id,
          submittedAt: new Date().toISOString(),
          fields: fields.reduce<Record<string, unknown>>((acc, f) => { acc[f.label] = f.value; return acc; }, {}),
          attachments: [
            ...(signedApp ? [{ filename: `application-${ctx.applicationId}.pdf`, contentType: "application/pdf", contentBase64: signedApp.toString("base64") }] : []),
            ...additionalSignedDocs.map((d) => ({ filename: d.filename, contentType: "application/pdf", contentBase64: d.content.toString("base64") })),
            ...(creditSummary ? [{ filename: `credit-summary-${ctx.applicationId}.pdf`, contentType: "application/pdf", contentBase64: creditSummary.toString("base64") }] : []),
            ...docs.flatMap((g) => g.files.map((f) => ({ filename: f.filename, contentType: "application/octet-stream", category: g.category, contentBase64: f.content.toString("base64") }))),
          ],
        };
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 30_000);
        let resp: Response | null = null;
        try {
          for (let attempt = 1; attempt <= 2; attempt++) {
            try {
              resp = await fetch(endpoint, {
                method: "POST",
                headers,
                body: JSON.stringify(body),
                signal: controller.signal,
              });
              if (resp.status < 500) break;
            } catch (fetchErr) {
              if (attempt === 2) throw fetchErr;
              await new Promise((r) => setTimeout(r, 1500));
            }
          }
          if (resp && resp.ok) {
            ok = true;
            deliveredTo = endpoint;
            try {
              const respJson = await resp.json().catch(() => null);
              console.log(`[dispatch] api success ${l.name} ref=${respJson?.id ?? respJson?.reference ?? "—"}`);
            } catch { }
          } else {
            ok = false;
            const txt = resp ? await resp.text().catch(() => "") : "no response";
            error = `api_${resp?.status ?? "network"}: ${txt.slice(0, 200)}`;
          }
        } catch (apiErr) {
          ok = false;
          error = `api_request_failed: ${apiErr instanceof Error ? apiErr.message : String(apiErr)}`;
        } finally {
          clearTimeout(timeout);
        }
      }
    } else if (method === "google_sheet") {
      const googleAdapter = await (deps.loadGoogleAdapter ?? loadGoogleAdapter)();
      if (!l.google_sheet_id) {
        error = "missing_google_sheet_id";
      } else if (!googleAdapter) {
        error = "google_adapter_unavailable";
      } else {
        // BF_SERVER_GSHEET_ROW_v1 - idempotency claim so a worker retry can't append
        // a duplicate row for the same (application, lender). If already claimed, skip.
        const release = async () => {
          await ctx.pool
            .query(`DELETE FROM lender_sheet_dispatches WHERE application_id = $1 AND lender_id = $2`, [ctx.applicationId, l.lender_id])
            .catch(() => {});
        };
        try {
          const claim = await ctx.pool.query(
            `INSERT INTO lender_sheet_dispatches (application_id, lender_id)
             VALUES ($1, $2)
             ON CONFLICT (application_id, lender_id) DO NOTHING
             RETURNING application_id`,
            [ctx.applicationId, l.lender_id],
          );
          if (claim.rowCount === 0) {
            // Already appended in a prior attempt - treat as delivered, don't duplicate.
            ok = true;
            deliveredTo = l.google_sheet_id;
          } else {
            // BF_SERVER_GSHEET_ROW_v1 - build the REAL, column-ordered row from the
            // application (the old path submitted {} -> a blank row).
            const { loadSheetRowData, buildSheetRow } = await import("../../modules/submissions/merchantGrowthSheet.js");
            const rowData = await loadSheetRowData(ctx.pool, ctx.applicationId);
            const { values } = buildSheetRow(rowData);
            const adapter = new googleAdapter({
              payload: {
                application: {
                  id: ctx.applicationId,
                  ownerUserId: null,
                  name: `Application ${ctx.applicationId}`,
                  metadata: {},
                  productType: "",
                  lenderId: l.lender_id,
                  lenderProductId: null,
                  requestedAmount: null,
                },
                documents: [],
                submittedAt: new Date().toISOString(),
              },
              config: {
                spreadsheetId: l.google_sheet_id,
                sheetName: l.google_sheet_tab ?? null,
                columnMapVersion: "v1",
              },
            });
            const result =
              typeof adapter.appendRow === "function"
                ? await adapter.appendRow(values)
                : await adapter.submit({} as any);
            if (result.success) {
              ok = true;
              deliveredTo = l.google_sheet_id;
            } else {
              ok = false;
              error = result.failureReason ?? "google_sheet_failed";
              await release();
            }
          }
        } catch (sheetErr) {
          ok = false;
          error = `google_sheet_error: ${sheetErr instanceof Error ? sheetErr.message : String(sheetErr)}`;
          await release();
        }
      }
    } else {
      error = `unknown_submission_method:${method}`;
    }

    void deliveredTo;
    await ctx.pool.query(
      `INSERT INTO application_packages
         (id, application_id, lender_id, status, failure_reason, size_bytes, built_at, sent_at, created_at)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, NOW(),
               CASE WHEN $3 = 'sent' THEN NOW() ELSE NULL END, NOW())
       ON CONFLICT (application_id, lender_id) DO NOTHING
       RETURNING id`,
      [ctx.applicationId, l.lender_id, ok ? "sent" : "failed", error, pkg.zipBuffer.length]
    )
      .then((rs) => {
        if (!rs.rowCount) {
          console.warn("[dispatch] application_packages duplicate suppressed", {
            applicationId: ctx.applicationId,
            lenderId: l.lender_id,
          });
        }
      })
      .catch((e) => { console.error("[dispatch] failed to record application_packages row", e); });

    if (ok) sent.push(l.lender_id);
  }
  return sent;
}
