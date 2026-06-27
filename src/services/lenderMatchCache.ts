// BF_SERVER_BLOCK_v198_LENDER_MATCH_GATE_AND_CACHE_v1
import { pool } from "../db.js";
import { matchLenders, type LenderMatch } from "../ai/lenderMatchEngine.js";

export type LenderMatchEnvelope = {
  status: "locked" | "stale" | "ready";
  outstanding: string[];
  computed_at: string | null;
  matches: any[];
  inputs: any;
  missing_inputs: string[];
};

// BF_SERVER_BLOCK_v206_LENDER_CATEGORY_FILTER_AND_PREVIEW_FALLBACK_v1 — pull product_category for filtering.
export function extractMatchInputs(app: { metadata: any; requested_amount: any; product_category?: string | null }, applicationId?: string) {
  const meta = (app.metadata && typeof app.metadata === "object") ? (app.metadata as Record<string, any>) : {};
  const requestedAmount = (() => {
    const raw = app.requested_amount ?? meta.requestedAmount ?? meta.amount ?? meta.fundingAmount ?? null;
    if (raw === null || raw === undefined || raw === "") return null;
    const n = typeof raw === "number" ? raw : Number(String(raw).replace(/[^0-9.\-]/g, ""));
    return Number.isFinite(n) ? n : null;
  })();
  // BF_SERVER_BLOCK_v724_MATCH_COUNTRY_SOURCES_v1 — the wizard derives country from
  // kyc.businessLocation and stores it as address_country on the company/applicant.
  // The old extraction only read top-level country/businessCountry/businessLocation,
  // so Canadian apps resolved to null and the geography gate went permissive, letting
  // US lender products match a CA application. Read the keys the wizard actually writes.
  const country = (() => {
    const raw = String(
      meta.country
      ?? meta.businessCountry
      ?? meta.businessLocation
      ?? meta.address_country
      ?? meta.kyc?.businessLocation
      ?? meta.kyc?.country
      ?? meta.kyc?.address_country
      ?? meta.business?.address_country
      ?? meta.business?.country
      ?? meta.company?.address_country
      ?? meta.company?.country
      ?? meta.applicant?.address_country
      ?? ""
    ).trim().toUpperCase();
    if (raw === "CA" || raw === "CANADA") return "CA" as const;
    if (raw === "US" || raw === "USA" || raw === "UNITED STATES") return "US" as const;
    return null;
  })();
  const province = typeof meta.province === "string" ? meta.province
    : (typeof meta.state === "string" ? meta.state : null);
  const industry = typeof meta.industry === "string" ? meta.industry : null;
  const revenue = (() => {
    const raw = meta.annualRevenue ?? meta.revenue ?? null;
    if (raw === null || raw === undefined || raw === "") return null;
    const n = typeof raw === "number" ? raw : Number(String(raw).replace(/[^0-9.\-]/g, ""));
    return Number.isFinite(n) ? n : null;
  })();
  const timeInBusiness = (() => {
    const raw = meta.timeInBusinessMonths ?? meta.monthsInBusiness ?? meta.timeInBusiness ?? null;
    if (raw === null || raw === undefined || raw === "") return null;
    const n = typeof raw === "number" ? raw : Number(raw);
    return Number.isFinite(n) ? n : null;
  })();
  // BF_SERVER_BLOCK_v210_LENDER_CATEGORY_ALIAS_AND_OCR_AUDIT_v1
  // Wizard stores product category in several places depending on which step
  // wrote it. Check column first, then the metadata paths the wizard uses.
  const productCategory = (() => {
    const raw =
         app.product_category
      ?? meta.product_category
      ?? meta.productCategory
      ?? meta.selectedProductType
      ?? meta.selectedProduct?.category
      ?? meta.selected_product?.category
      ?? meta.kyc?.productCategory
      ?? meta.kyc_responses?.productCategory
      ?? meta.kyc?.product_category
      ?? null;
    if (raw === null || raw === undefined || raw === "") return null;
    return String(raw).trim();
  })();
  // BF_SERVER_LENDER_MATCH_DUAL_v1 — closing-cost companions (and any app) can
  // carry metadata.match_categories to match more than one product category.
  const productCategories = (() => {
    const raw = meta.match_categories ?? meta.matchCategories ?? null;
    if (Array.isArray(raw)) {
      const arr = raw.map((x: any) => String(x).trim()).filter(Boolean);
      return arr.length ? arr : null;
    }
    return null;
  })();
  if (requestedAmount == null || productCategory == null) {
    console.info({
      event: "lender_match_input_incomplete",
      applicationId: applicationId ?? null,
      hasAmount: requestedAmount != null,
      hasCategory: productCategory != null,
      country,
      metadataKeys: Object.keys(meta).slice(0, 20),
    });
  }
  return { requestedAmount, country, province, industry, revenue, timeInBusiness, productCategory, productCategories };
}

async function enrichWithSubmissions(applicationId: string, matches: LenderMatch[]) {
  const submissionMap = new Map<string, { status: string; submittedAt: string | null }>();
  try {
    const subRes = await pool.query<{ lender_product_id: string; status: string; submitted_at: string | null }>(
      `SELECT lender_product_id, status, submitted_at
         FROM lender_submissions
        WHERE application_id::text = ($1)::text`,
      [applicationId]
    );
    for (const r of subRes.rows) {
      if (r.lender_product_id) {
        submissionMap.set(String(r.lender_product_id), { status: r.status, submittedAt: r.submitted_at });
      }
    }
  } catch { /* schema drift tolerated */ }

  return matches.map((m) => {
    const sub = submissionMap.get(m.id);
    return {
      ...m,
      matchPercentage: m.matchPercent,
      matchScore: m.matchPercent,
      submissionStatus: sub?.status ?? null,
      submittedAt: sub?.submittedAt ?? null,
    };
  });
}

export async function getOutstandingRequiredDocs(applicationId: string): Promise<string[]> {
  const res = await pool.query<{ document_category: string }>(
    `SELECT document_category
       FROM application_required_documents
      WHERE application_id::text = ($1)::text
        AND status != 'accepted'
      ORDER BY created_at`,
    [applicationId]
  ).catch(() => null);
  return (res?.rows ?? []).map((r) => r.document_category).filter(Boolean);
}

export async function computeAndCacheLenderMatches(applicationId: string): Promise<{ matches: any[]; inputs: any; missing_inputs: string[] }> {
  const appRes = await pool.query(
    `SELECT id, metadata, requested_amount, product_category FROM applications WHERE id::text = ($1)::text LIMIT 1`,
    [applicationId]
  );
  const app = appRes.rows[0];
  if (!app) return { matches: [], inputs: null, missing_inputs: ["application_not_found"] };

  const inputs = extractMatchInputs(app, applicationId);

  const missing_inputs: string[] = [];
  if (inputs.requestedAmount === null || inputs.requestedAmount === undefined) missing_inputs.push("requested_amount");
  if (inputs.productCategory === null || inputs.productCategory === undefined) missing_inputs.push("product_category");

  if (missing_inputs.length > 0) {
    await pool.query(
      `UPDATE applications
          SET lender_matches = '[]'::jsonb,
              lender_matches_computed_at = now(),
              lender_matches_stale = false,
              lender_matches_inputs = $1::jsonb,
              lender_matches_missing_inputs = $2::jsonb,
              updated_at = now()
        WHERE id::text = ($3)::text`,
      [JSON.stringify(inputs), JSON.stringify(missing_inputs), applicationId]
    ).catch((err) => console.warn("lender_match_strict_write_failed", { applicationId, message: err?.message }));
    return { matches: [], inputs, missing_inputs };
  }

  let matches: LenderMatch[] = [];
  try {
    matches = await matchLenders(inputs);
  } catch (err: any) {
    console.warn("lender_match_compute_failed", { applicationId, message: err?.message });
    matches = [];
  }
  const enriched = await enrichWithSubmissions(applicationId, matches);
  await pool.query(
    `UPDATE applications
        SET lender_matches = $1::jsonb,
            lender_matches_computed_at = now(),
            lender_matches_stale = false,
            lender_matches_inputs = $2::jsonb,
            lender_matches_missing_inputs = '[]'::jsonb,
            updated_at = now()
      WHERE id::text = ($3)::text`,
    [JSON.stringify(enriched), JSON.stringify(inputs), applicationId]
  ).catch((err) => console.warn("lender_match_cache_write_failed", { applicationId, message: err?.message }));
  return { matches: enriched, inputs, missing_inputs: [] };
}

export async function markLenderMatchesStale(applicationId: string): Promise<void> {
  await pool.query(
    `UPDATE applications
        SET lender_matches_stale = true, updated_at = now()
      WHERE id::text = ($1)::text`,
    [applicationId]
  ).catch((err) => {
    console.warn("lender_match_stale_write_failed", { applicationId, message: err?.message });
  });
}

export async function readLenderMatchEnvelope(applicationId: string): Promise<LenderMatchEnvelope> {
  const res = await pool.query<{
    lender_matches: any;
    lender_matches_computed_at: string | null;
    lender_matches_stale: boolean | null;
    lender_matches_inputs: any;
    lender_matches_missing_inputs: any;
  }>(
    `SELECT lender_matches, lender_matches_computed_at, lender_matches_stale, lender_matches_inputs, lender_matches_missing_inputs
       FROM applications
      WHERE id::text = ($1)::text
      LIMIT 1`,
    [applicationId]
  );
  const row = res.rows[0];
  if (!row) {
    return { status: "locked", outstanding: [], computed_at: null, matches: [], inputs: null, missing_inputs: [] };
  }
  const outstanding = await getOutstandingRequiredDocs(applicationId);
  const inputs = row.lender_matches_inputs ?? null;
  const missingInputs = Array.isArray(row.lender_matches_missing_inputs) ? row.lender_matches_missing_inputs : [];
  if (outstanding.length > 0) {
    return { status: "locked", outstanding, computed_at: null, matches: [], inputs, missing_inputs: missingInputs };
  }
  const cached: any[] = Array.isArray(row.lender_matches) ? row.lender_matches : [];
  const computedAt = row.lender_matches_computed_at;
  const stale = row.lender_matches_stale === true;
  if (stale || !computedAt || cached.length === 0) {
    return { status: "stale", outstanding: [], computed_at: computedAt, matches: cached, inputs, missing_inputs: missingInputs };
  }
  return { status: "ready", outstanding: [], computed_at: computedAt, matches: cached, inputs, missing_inputs: missingInputs };
}

export async function readCachedMatchesArray(applicationId: string): Promise<any[]> {
  const res = await pool.query<{ lender_matches: any }>(
    `SELECT lender_matches FROM applications WHERE id::text = ($1)::text LIMIT 1`,
    [applicationId]
  ).catch(() => null);
  const arr = res?.rows[0]?.lender_matches;
  return Array.isArray(arr) ? arr : [];
}
