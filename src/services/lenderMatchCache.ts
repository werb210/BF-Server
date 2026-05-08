// BF_SERVER_BLOCK_v198_LENDER_MATCH_GATE_AND_CACHE_v1
import { pool } from "../db.js";
import { matchLenders, type LenderMatch } from "../ai/lenderMatchEngine.js";

export type LenderMatchEnvelope = {
  status: "locked" | "stale" | "ready";
  outstanding: string[];
  computed_at: string | null;
  matches: any[];
};

// BF_SERVER_BLOCK_v206_LENDER_CATEGORY_FILTER_AND_PREVIEW_FALLBACK_v1 — pull product_category for filtering.
function extractMatchInputs(app: { metadata: any; requested_amount: any; product_category?: string | null }) {
  const meta = (app.metadata && typeof app.metadata === "object") ? (app.metadata as Record<string, any>) : {};
  const requestedAmount = (() => {
    const raw = app.requested_amount ?? meta.requestedAmount ?? meta.amount ?? meta.fundingAmount ?? null;
    if (raw === null || raw === undefined || raw === "") return null;
    const n = typeof raw === "number" ? raw : Number(String(raw).replace(/[^0-9.\-]/g, ""));
    return Number.isFinite(n) ? n : null;
  })();
  const country = (() => {
    const raw = String(meta.country ?? meta.businessCountry ?? meta.businessLocation ?? "").trim().toUpperCase();
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
  const productCategory = (() => {
    const raw = app.product_category
      ?? meta.product_category
      ?? meta.productCategory
      ?? meta.selectedProductType
      ?? null;
    if (raw === null || raw === undefined || raw === "") return null;
    return String(raw).trim();
  })();
  return { requestedAmount, country, province, industry, revenue, timeInBusiness, productCategory };
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

export async function computeAndCacheLenderMatches(applicationId: string): Promise<any[]> {
  const appRes = await pool.query(
    `SELECT id, metadata, requested_amount, product_category FROM applications WHERE id::text = ($1)::text LIMIT 1`,
    [applicationId]
  );
  const app = appRes.rows[0];
  if (!app) return [];

  let matches: LenderMatch[] = [];
  try {
    matches = await matchLenders(extractMatchInputs(app));
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
            updated_at = now()
      WHERE id::text = ($2)::text`,
    [JSON.stringify(enriched), applicationId]
  ).catch((err) => {
    console.warn("lender_match_cache_write_failed", { applicationId, message: err?.message });
  });
  return enriched;
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
  }>(
    `SELECT lender_matches, lender_matches_computed_at, lender_matches_stale
       FROM applications
      WHERE id::text = ($1)::text
      LIMIT 1`,
    [applicationId]
  );
  const row = res.rows[0];
  if (!row) {
    return { status: "locked", outstanding: [], computed_at: null, matches: [] };
  }
  const outstanding = await getOutstandingRequiredDocs(applicationId);
  if (outstanding.length > 0) {
    return { status: "locked", outstanding, computed_at: null, matches: [] };
  }
  const cached: any[] = Array.isArray(row.lender_matches) ? row.lender_matches : [];
  const computedAt = row.lender_matches_computed_at;
  const stale = row.lender_matches_stale === true;
  if (stale || !computedAt || cached.length === 0) {
    return { status: "stale", outstanding: [], computed_at: computedAt, matches: cached };
  }
  return { status: "ready", outstanding: [], computed_at: computedAt, matches: cached };
}

export async function readCachedMatchesArray(applicationId: string): Promise<any[]> {
  const res = await pool.query<{ lender_matches: any }>(
    `SELECT lender_matches FROM applications WHERE id::text = ($1)::text LIMIT 1`,
    [applicationId]
  ).catch(() => null);
  const arr = res?.rows[0]?.lender_matches;
  return Array.isArray(arr) ? arr : [];
}
