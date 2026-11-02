// BF_SERVER_v867_BROKER_TOOLS_VENDORS - equipment vendor / dealer portal.
//
// A vendor is a partner login (users row: role Referrer, partner_kind 'vendor', phone-code login like the broker
// portal) with a profile here: company, referral code and fee terms. In the portal the vendor quotes a customer at the
// point of sale from the lender rate cards (with sales tax), hands the customer an apply link that carries the
// vendor as the source (?ref=<code>&vq=<quote>), follows each deal's status, uploads the invoice for it, and sees the
// fees owed. A funded deal from the vendor creates the vendor fee (percent of the funded amount and/or a flat
// amount), tracked expected -> paid like referrer fees. Vendors sign the vendor agreement through SignNow.
import { randomBytes, randomUUID } from "node:crypto";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import type { Q } from "./common.js";
import { cents, num, str } from "./common.js";
import { brand, clientAppUrl } from "./platform.js";
import { pdfSafe } from "./docx.js";
import { normaliseProvince } from "./salesTax.js";

export const VENDOR_ROLE = "Vendor";

export type Vendor = {
  user_id: string; company_name: string; contact_name: string | null; email: string | null; phone: string | null; province: string | null;
  code: string; status: "invited" | "pending_agreement" | "active" | "paused"; fee_pct: number | null; fee_flat: number | null; fee_terms: string | null; notes: string | null;
};

export const newCode = (company: string) => {
  const stem = company.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6) || "VENDOR";
  return `${stem}-${randomBytes(3).toString("hex").toUpperCase()}`;
};

/** The customer's apply link: the client app with the vendor as the source and the quote it came from. */
export function applyLink(code: string, quoteId?: string | null): string {
  const p = new URLSearchParams({ ref: code, utm_source: "vendor", utm_medium: "vendor_portal", utm_campaign: code });
  if (quoteId) p.set("vq", quoteId);
  return `${clientAppUrl()}/?${p.toString()}`;
}

/** The fee owed on a funded deal: percent of the funded amount plus any flat amount. */
export function vendorFee(v: Pick<Vendor, "fee_pct" | "fee_flat">, funded: number): number {
  return cents(((v.fee_pct ?? 0) * funded) / 100 + (v.fee_flat ?? 0));
}

export function parseVendorInput(b: Record<string, unknown>, partial = false): { ok: true; value: Partial<Vendor> } | { ok: false; error: string } {
  const v: Partial<Vendor> = {};
  if (!partial || b.company_name !== undefined) {
    const c = str(b.company_name, 200);
    if (!c) return { ok: false, error: "Enter the vendor's company name." };
    v.company_name = c;
  }
  if (!partial || b.phone !== undefined) {
    const d = String(b.phone ?? "").replace(/[^0-9]/g, "");
    if (d.length < 10) return { ok: false, error: "Enter the vendor contact's mobile number (they log in with it)." };
    v.phone = `+1${d.slice(-10)}`;
  }
  if (!partial || b.email !== undefined) {
    const e = str(b.email, 200);
    if (!e || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)) return { ok: false, error: "Enter the vendor contact's email." };
    v.email = e.toLowerCase();
  }
  if (b.contact_name !== undefined) v.contact_name = str(b.contact_name, 200);
  if (b.province !== undefined) v.province = normaliseProvince(b.province);
  if (b.fee_pct !== undefined) {
    const n = b.fee_pct === "" || b.fee_pct === null ? null : num(b.fee_pct);
    if (n !== null && (n < 0 || n > 20)) return { ok: false, error: "The fee is 0 to 20% of the funded amount." };
    v.fee_pct = n;
  }
  if (b.fee_flat !== undefined) {
    const n = b.fee_flat === "" || b.fee_flat === null ? null : num(b.fee_flat);
    if (n !== null && (n < 0 || n > 1e6)) return { ok: false, error: "Check the flat fee." };
    v.fee_flat = n === null ? null : cents(n);
  }
  if (b.fee_terms !== undefined) v.fee_terms = str(b.fee_terms, 2000);
  if (b.notes !== undefined) v.notes = str(b.notes, 4000);
  if (b.status !== undefined) {
    if (!["active", "paused"].includes(String(b.status))) return { ok: false, error: "A vendor is active or paused." };
    v.status = String(b.status) as Vendor["status"];
  }
  return { ok: true, value: v };
}

const V_COLS = `user_id::text AS user_id, company_name, contact_name, email, phone, province, code, status, fee_pct, fee_flat, fee_terms, notes`;
const toVendor = (r: Record<string, any>): Vendor => ({
  ...r, fee_pct: r.fee_pct === null || r.fee_pct === undefined ? null : Number(r.fee_pct), fee_flat: r.fee_flat === null || r.fee_flat === undefined ? null : Number(r.fee_flat),
} as Vendor);

export async function getVendor(q: Q, userId: string): Promise<Vendor | null> {
  const r = await q.query(`SELECT ${V_COLS} FROM vendor_profiles WHERE user_id::text = $1 LIMIT 1`, [userId]);
  return r.rows[0] ? toVendor(r.rows[0]) : null;
}

export async function vendorByCode(q: Q, code: string): Promise<Vendor | null> {
  const r = await q.query(`SELECT ${V_COLS} FROM vendor_profiles WHERE lower(code) = lower($1) LIMIT 1`, [code]);
  return r.rows[0] ? toVendor(r.rows[0]) : null;
}

export class VendorError extends Error {}

/** Creates the vendor's login (pending its agreement) and profile. A phone or email already used by another login is refused. */
export async function createVendor(q: Q, v: Partial<Vendor>, silo: string, actor: string | null, status: Vendor["status"] = "invited"): Promise<Vendor> {
  const taken = await q.query(
    `SELECT id FROM users WHERE lower(email) = lower($1) OR right(regexp_replace(coalesce(phone_number, ''), '[^0-9]', '', 'g'), 10) = right($2, 10) LIMIT 1`,
    [v.email, String(v.phone ?? "").replace(/[^0-9]/g, "")],
  );
  if (taken.rows[0]) throw new VendorError("That email or mobile number already has a login. Use a different contact for the vendor.");
  const id = randomUUID();
  const [first, ...rest] = String(v.contact_name ?? v.company_name ?? "").split(/\s+/);
  await q.query(
    `INSERT INTO users (id, first_name, last_name, email, phone_number, company_name, province, role, referrer_status, partner_kind, active, status, profile_complete, created_at, updated_at)
     VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, 'Referrer', 'pending_agreement', 'vendor', true, 'ACTIVE', true, now(), now())`,
    [id, first || null, rest.join(" ") || null, v.email, v.phone, v.company_name, v.province ?? null],
  );
  await q.query(
    `INSERT INTO vendor_profiles (user_id, silo, company_name, contact_name, email, phone, province, code, status, fee_pct, fee_flat, fee_terms, notes, created_by)
     VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14::uuid)`,
    [id, silo, v.company_name, v.contact_name ?? null, v.email, v.phone, v.province ?? null, newCode(String(v.company_name)), status, v.fee_pct ?? null, v.fee_flat ?? null, v.fee_terms ?? null, v.notes ?? null, actor],
  );
  return (await getVendor(q, id))!;
}

export async function updateVendor(q: Q, userId: string, v: Partial<Vendor>): Promise<Vendor | null> {
  const sets: string[] = [];
  const params: unknown[] = [userId];
  for (const k of ["company_name", "contact_name", "email", "phone", "province", "fee_pct", "fee_flat", "fee_terms", "notes", "status"] as const) {
    if (v[k] === undefined) continue;
    params.push(v[k]);
    sets.push(`${k} = $${params.length}`);
  }
  if (sets.length) await q.query(`UPDATE vendor_profiles SET ${sets.join(", ")}, updated_at = now() WHERE user_id::text = $1`, params);
  if (v.status === "active") await q.query(`UPDATE users SET referrer_status = 'active', agreement_signed_at = COALESCE(agreement_signed_at, now()), updated_at = now() WHERE id::text = $1`, [userId]);
  if (v.phone !== undefined || v.email !== undefined) await q.query(`UPDATE users SET phone_number = COALESCE($2, phone_number), email = COALESCE($3, email), updated_at = now() WHERE id::text = $1`, [userId, v.phone ?? null, v.email ?? null]);
  return getVendor(q, userId);
}

/** A signed agreement (the SignNow webhook flips users.referrer_status) makes the vendor active. */
export async function syncAgreement(q: Q, userId: string): Promise<Vendor | null> {
  await q.query(
    `UPDATE vendor_profiles vp SET status = 'active', updated_at = now() FROM users u
      WHERE vp.user_id = u.id AND vp.user_id::text = $1 AND u.referrer_status = 'active' AND vp.status IN ('invited','pending_agreement')`,
    [userId],
  );
  return getVendor(q, userId);
}

/** The vendor agreement as a PDF with SignNow text tags for the vendor's signature, name and date. */
export async function vendorAgreementPdf(v: Vendor): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const F = await doc.embedFont(StandardFonts.Helvetica), B = await doc.embedFont(StandardFonts.HelveticaBold);
  const page = doc.addPage([612, 792]);
  let y = 740;
  const line = (t: string, font = F, size = 10.5, gap = 4) => {
    const words = pdfSafe(t).split(" ");
    let cur = "";
    for (const w of words) {
      if (font.widthOfTextAtSize(`${cur} ${w}`.trim(), size) > 504) { page.drawText(cur, { x: 54, y, size, font }); y -= size * 1.4; cur = w; } else cur = `${cur} ${w}`.trim();
    }
    if (cur) { page.drawText(cur, { x: 54, y, size, font }); y -= size * 1.4; }
    y -= gap;
  };
  const fee = [v.fee_pct ? `${v.fee_pct}% of the amount funded` : null, v.fee_flat ? `$${v.fee_flat.toFixed(2)} per funded deal` : null].filter(Boolean).join(" plus ") || "as agreed in writing for each deal";
  line(`${brand()} - Vendor Referral Agreement`, B, 15, 10);
  line(`Between ${brand()} (the "Broker") and ${v.company_name} (the "Vendor").`);
  line("1. The Vendor may refer its customers who want to finance equipment it sells to the Broker, using the Vendor portal and the apply links it provides. The Vendor will not hold itself out as a lender and will not promise approval, rates or terms.");
  line("2. Quotes in the Vendor portal are estimates from lender rate cards and are not offers of credit. Every deal is subject to the lender's credit approval and documentation.");
  line(`3. For each referred deal the lender funds, the Broker pays the Vendor a fee of ${fee}, within 30 days after the Broker is paid by the lender.${v.fee_terms ? ` ${v.fee_terms}` : ""}`);
  line("4. The Vendor will give the Broker true and complete invoices for the equipment, will deliver the equipment invoiced, and will tell the Broker at once of any change to a deal.");
  line("5. Each party keeps the other's customer information confidential and uses it only for the deal. Either party may end this agreement by written notice; fees earned before then are still paid.");
  y -= 20;
  line("Vendor", B, 11, 18);
  page.drawText(`{{t:s;r:y;o:"${VENDOR_ROLE}";w:200;h:30;}}`, { x: 56, y: y + 8, size: 6, font: F, color: rgb(1, 1, 1) });
  page.drawLine({ start: { x: 54, y }, end: { x: 300, y }, thickness: 0.7 });
  y -= 30;
  page.drawText(`{{t:t;r:y;o:"${VENDOR_ROLE}";l:"Name and title";w:220;h:16;}}`, { x: 56, y: y + 6, size: 6, font: F, color: rgb(1, 1, 1) });
  page.drawLine({ start: { x: 54, y }, end: { x: 300, y }, thickness: 0.7 });
  page.drawText(`{{t:t;r:y;o:"${VENDOR_ROLE}";l:"Date";w:110;h:16;}}`, { x: 330, y: y + 6, size: 6, font: F, color: rgb(1, 1, 1) });
  page.drawLine({ start: { x: 330, y }, end: { x: 450, y }, thickness: 0.7 });
  page.drawText("Signature, name and title, date", { x: 54, y: y - 12, size: 8, font: F, color: rgb(0.35, 0.35, 0.35) });
  return doc.save();
}

/** Starts the SignNow signing of the vendor agreement; returns the signing link (the webhook activates the vendor). */
export async function startAgreement(q: Q, v: Vendor): Promise<{ url: string } | null> {
  const sn = await import("../signnow/signnowClient.js");
  if (!sn.isApiKeyConfigured()) return null;
  const pdf = await vendorAgreementPdf(v);
  const { documentId } = await sn.uploadDocumentWithFieldExtract(pdf, `${brand()} Vendor Agreement - ${v.company_name} - ${v.user_id}.pdf`);
  const { groupId } = await sn.createDocumentGroup([documentId], `Vendor Agreement ${v.user_id}`);
  const { inviteId } = await sn.createEmbeddedGroupInvite(groupId, [documentId], [{ email: String(v.email), name: v.contact_name ?? v.company_name, roleName: VENDOR_ROLE }]);
  const { url } = await sn.createEmbeddedGroupLink(groupId, inviteId, String(v.email));
  await q.query(`UPDATE users SET agreement_document_group_id = $2, agreement_document_id = $3, updated_at = now() WHERE id::text = $1`, [v.user_id, groupId, documentId]);
  await q.query(`UPDATE vendor_profiles SET status = 'pending_agreement', updated_at = now() WHERE user_id::text = $1 AND status = 'invited'`, [v.user_id]);
  return { url };
}

// ------------------------------------------------------------------------------------------------ deals and fees
/** The vendor's deals: applications that came in through the vendor's apply link. Status only - no lender terms. */
export async function vendorDeals(q: Q, v: Vendor): Promise<Record<string, any>[]> {
  const r = await q.query(
    `SELECT a.id::text AS application_id, COALESCE(NULLIF(a.metadata->'business'->>'legalName', ''), a.name) AS business_name, a.pipeline_state AS stage,
            a.requested_amount, a.funded_at, a.created_at, a.metadata->'attribution'->>'vq' AS quote_id,
            (SELECT count(*)::int FROM documents d WHERE d.application_id::text = a.id::text AND d.uploaded_by = 'vendor') AS invoices_sent,
            vf.fee_amount, vf.status AS fee_status, vf.paid_on
       FROM applications a
       LEFT JOIN vendor_fees vf ON vf.application_id = a.id::text AND vf.vendor_id = $1::uuid
      WHERE lower(a.metadata->'attribution'->>'ref') = lower($2)
      ORDER BY a.created_at DESC LIMIT 300`,
    [v.user_id, v.code],
  );
  return r.rows;
}

export async function ownsDeal(q: Q, v: Vendor, applicationId: string): Promise<boolean> {
  const r = await q.query(`SELECT 1 FROM applications a WHERE a.id::text = $1 AND lower(a.metadata->'attribution'->>'ref') = lower($2) LIMIT 1`, [applicationId, v.code]);
  return Boolean(r.rows[0]);
}

/** After-funded step: a deal from a vendor's link records the vendor fee (once). */
export async function vendorFeeOnFunded(q: Q, applicationId: string): Promise<boolean> {
  const a = await q.query(
    `SELECT a.metadata->'attribution'->>'ref' AS ref, COALESCE(a.funded_amount, a.requested_amount) AS amount FROM applications a WHERE a.id::text = $1 LIMIT 1`,
    [applicationId],
  );
  const ref = a.rows[0]?.ref;
  const amount = Number(a.rows[0]?.amount);
  if (!ref || !(amount > 0)) return false;
  const v = await vendorByCode(q, String(ref));
  if (!v) return false;
  const fee = vendorFee(v, amount);
  if (!(fee > 0)) return false;
  const r = await q.query(
    `INSERT INTO vendor_fees (vendor_id, application_id, basis_amount, fee_amount, note) VALUES ($1::uuid, $2, $3, $4, $5) ON CONFLICT DO NOTHING RETURNING id`,
    [v.user_id, applicationId, cents(amount), fee, [v.fee_pct ? `${v.fee_pct}%` : null, v.fee_flat ? `$${v.fee_flat} flat` : null].filter(Boolean).join(" + ")],
  );
  return Boolean(r.rows[0]);
}

export async function listFees(q: Q, opts: { vendorId?: string | null; status?: string | null; silo?: string | null } = {}): Promise<Record<string, any>[]> {
  const r = await q.query(
    `SELECT vf.id::text AS id, vf.vendor_id::text AS vendor_id, vp.company_name AS vendor, vf.application_id, COALESCE(NULLIF(a.metadata->'business'->>'legalName', ''), a.name) AS business_name,
            vf.basis_amount, vf.fee_amount, vf.status, vf.paid_on, vf.note, vf.created_at
       FROM vendor_fees vf JOIN vendor_profiles vp ON vp.user_id = vf.vendor_id LEFT JOIN applications a ON a.id::text = vf.application_id
      WHERE ($1::text IS NULL OR vf.vendor_id::text = $1) AND ($2::text IS NULL OR vf.status = $2) AND ($3::text IS NULL OR vp.silo = $3)
      ORDER BY vf.created_at DESC LIMIT 1000`,
    [opts.vendorId ?? null, opts.status ?? null, opts.silo ?? null],
  );
  return r.rows;
}
