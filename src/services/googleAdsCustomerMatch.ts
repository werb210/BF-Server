// BF_SERVER_GOOGLE_ADS_CUSTOMER_MATCH_v1 - ideal-client engine. Defines a seed of
// funded BF clients (optionally segmented by product / deal-size band), excludes
// opted-out contacts, and produces a Google Customer Match-ready HASHED list
// (SHA-256 email/phone) plus an exclusion list of all funded clients. Uploading
// hashed PII to ad platforms is a "sensitive data" action under PIPEDA/CASL and
// the compliant standard is EXPRESS opt-in; this gate includes funded contacts by
// default (implied consent) and honors the durable marketing_opt_out suppression flag. No raw PII leaves the server - only SHA-256 hashes.
import { createHash } from "crypto";
import { pool } from "../db.js";

const FUNDED_STATES = ["Accepted", "Funded"];

export type IcpFilters = { productCategory?: string; minAmount?: number; maxAmount?: number };
type SeedRow = { email: string | null; phone: string | null };

function amountBand(v: number | null): string {
  const n = Number(v ?? 0);
  if (!n) return "unknown";
  if (n < 100_000) return "<100k";
  if (n < 500_000) return "100k-500k";
  return "500k+";
}

async function querySeed(silo: string, filters: IcpFilters, idealOnly: boolean): Promise<Array<SeedRow & { product_category: string | null; requested_amount: number | null }>> {
  const params: any[] = [silo, FUNDED_STATES];
  let where = `a.silo = $1 AND a.pipeline_state = ANY($2) AND COALESCE(c.email,'') <> '' AND COALESCE(c.marketing_opt_out, false) = false`;
  if (idealOnly) {
    if (filters.productCategory) { params.push(filters.productCategory); where += ` AND a.product_category = $${params.length}`; }
    if (typeof filters.minAmount === "number") { params.push(filters.minAmount); where += ` AND COALESCE(a.requested_amount,0) >= $${params.length}`; }
    if (typeof filters.maxAmount === "number") { params.push(filters.maxAmount); where += ` AND COALESCE(a.requested_amount,0) <= $${params.length}`; }
  }
  const { rows } = await pool.query<SeedRow & { product_category: string | null; requested_amount: number | null }>(
    `SELECT DISTINCT c.email, c.phone, a.product_category, a.requested_amount
       FROM applications a JOIN contacts c ON c.id = a.contact_id
      WHERE ${where}`,
    params,
  );
  return rows;
}

export async function previewIcp(silo: string, filters: IcpFilters): Promise<{ eligible: number; withPhone: number; byProduct: Record<string, number>; byBand: Record<string, number> }> {
  const rows = await querySeed(silo, filters, true);
  const byProduct: Record<string, number> = {};
  const byBand: Record<string, number> = {};
  let withPhone = 0;
  for (const r of rows) {
    if (r.phone && String(r.phone).replace(/\D/g, "").length >= 10) withPhone++;
    const p = r.product_category || "(unspecified)";
    byProduct[p] = (byProduct[p] || 0) + 1;
    const b = amountBand(r.requested_amount);
    byBand[b] = (byBand[b] || 0) + 1;
  }
  return { eligible: rows.length, withPhone, byProduct, byBand };
}

const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");
function normEmail(e: string | null): string { return e ? sha256(e.trim().toLowerCase()) : ""; }
function normPhone(p: string | null): string {
  if (!p) return "";
  let d = String(p).replace(/\D/g, "");
  if (d.length === 10) d = "1" + d;
  if (!d) return "";
  return sha256("+" + d);
}

// Build a Customer Match CSV of SHA-256 hashes. type 'seed' = ideal clients
// (filtered); type 'exclusion' = ALL funded clients (to suppress from prospecting).
export async function buildHashedList(silo: string, filters: IcpFilters, type: "seed" | "exclusion"): Promise<{ rows: number; csv: string }> {
  const rows = await querySeed(silo, filters, type === "seed");
  const seen = new Set<string>();
  const lines = ["Email,Phone"];
  for (const r of rows) {
    const he = normEmail(r.email);
    const hp = normPhone(r.phone);
    if (!he && !hp) continue;
    const key = he + "|" + hp;
    if (seen.has(key)) continue;
    seen.add(key);
    lines.push(`${he},${hp}`);
  }
  return { rows: lines.length - 1, csv: lines.join("\n") };
}
