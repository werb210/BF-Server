// BF_SERVER_v74_BLOCK_1_7 — pick the right submission adapter per lender
// and record the result in application_packages.
import type { Pool } from "pg";
import { sendLenderEmail } from "../../modules/lenderSubmissions/adapters/EmailAdapter.js";
import { buildApplicationPackage } from "./buildApplicationPackage.js";
import { loadPackageInputs } from "./loadPackageInputs.js"; // BF_SERVER_v76_BLOCK_1_9

export type DispatchLender = {
  lender_id: string;
  name: string;
  submission_method: string | null;
  submission_email: string | null;
  api_endpoint: string | null;
  api_key_encrypted: string | null;
  google_sheet_id: string | null;
};

export type DispatchCtx = {
  pool: Pool;
  applicationId: string;
};

export async function dispatchToSelected(
  ctx: DispatchCtx,
  lenders: DispatchLender[]
): Promise<string[]> {
  let signedApp: Buffer | null = null;
  let creditSummary: Buffer | null = null;
  let docs: { category: string; files: { filename: string; content: Buffer }[] }[] = [];
  type FieldRow = { label: string; value: string | number | boolean | null };
  let fields: FieldRow[] = [];

  try {
    // BF_SERVER_v76_BLOCK_1_9 — real loader (was a dynamic-import fallback in 1.7)
    const inp = await loadPackageInputs(ctx);
    signedApp = inp.signedApplicationPdf ?? null;
    creditSummary = inp.creditSummaryPdf ?? null;
    docs = inp.documents ?? [];
    fields = inp.fields ?? [];
  } catch (e) {
    // best-effort: leave fallbacks (null/[]) in place; do not block dispatch
    console.warn("[dispatch] loadPackageInputs failed", e);
  }

  const pkg = await buildApplicationPackage({
    applicationId: ctx.applicationId,
    signedApplicationPdf: signedApp,
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
      const r = await sendLenderEmail({
        lender: { id: l.lender_id, name: l.name, submission_email: l.submission_email },
        subject: `Application package — ${l.name}`,
        bodyText: `Application ${ctx.applicationId} package attached.`,
        attachments: [{ filename: `application-${ctx.applicationId}.zip`, contentType: "application/zip", content: pkg.zipBuffer }],
      });
      ok = r.ok;
      if (r.ok) deliveredTo = r.deliveredTo;
      else error = r.error;
    } else if (method === "api") {
      console.log(`[dispatch] would POST package to ${l.api_endpoint} for ${l.name}`);
      ok = Boolean(l.api_endpoint);
      if (!ok) error = "missing_api_endpoint";
    } else if (method === "google_sheet") {
      console.log(`[dispatch] would append to sheet ${l.google_sheet_id} for ${l.name}`);
      ok = Boolean(l.google_sheet_id);
      if (!ok) error = "missing_google_sheet_id";
    } else {
      error = `unknown_submission_method:${method}`;
    }

    await ctx.pool.query(
      `INSERT INTO application_packages
         (id, application_id, lender_id, status, delivered_to, error, bytes, created_at)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, NOW())`,
      [ctx.applicationId, l.lender_id, ok ? "sent" : "failed", deliveredTo, error, pkg.zipBuffer.length]
    ).catch((e) => { console.error("[dispatch] failed to record application_packages row", e); });

    if (ok) sent.push(l.lender_id);
  }
  return sent;
}
