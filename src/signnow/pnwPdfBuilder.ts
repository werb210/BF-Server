// BF_SERVER_BLOCK_v_PNW_BUILDER_v1 — branded Personal Statement of Affairs
// (Personal Net Worth) generator. Renders application_form_responses
// doc_type 'net_worth_statement' (data = { fields, totals }) onto the Boreal
// template (navy #0b1320 header, gold #F5C443 rule, vector mountain logo).
// Authorization & Warranty entity/contact are fixed: "Boreal Financial Corp."
// / info@boreal.financial. Signature & Date carry invisible SignNow tags
// (Owner 1) so the page is wet-signable when added to the signing envelope.
import { PDFDocument, StandardFonts, rgb, PDFFont, PDFPage } from "pdf-lib";
import { dbQuery } from "../db.js";

const PW = 612, PH = 792, M = 42, CW = PW - 2 * M;
const NAVY = rgb(0.118, 0.227, 0.435);
const HDR = rgb(0.043, 0.075, 0.125);
const GOLD = rgb(0.961, 0.769, 0.263);
const INK = rgb(0.06, 0.09, 0.16);
const GREY = rgb(0.42, 0.46, 0.52);
const LINE = rgb(0.82, 0.84, 0.87);
const ROWBG = rgb(0.965, 0.973, 0.984);
const WHITE = rgb(1, 1, 1);
const MOUNTAIN = "M 99.82 70.67 L 75.05 14.75 L 73.04 13.84 L 62.11 20.77 L 55.56 2.19 L 52.64 0.0 L 36.07 31.15 L 28.78 24.59 L 0.0 71.22 Z M 50.82 17.3 L 67.58 64.48 L 34.97 64.48 L 17.67 56.83 L 30.24 35.88 L 35.34 42.62 L 36.98 42.44 Z";

const sv = (v: unknown): string => (v === null || v === undefined ? "" : String(v));
const money = (v: unknown): string => { if (v === null || v === undefined || v === "") return ""; const n = Number(String(v).replace(/[^0-9.\-]/g, "")); return Number.isFinite(n) ? "$" + Math.round(n).toLocaleString() : sv(v); };
const yn = (v: unknown): string => { const s = sv(v).toLowerCase(); if (s === "yes" || s === "true" || s === "y") return "Yes"; if (s === "no" || s === "false" || s === "n") return "No"; return s ? sv(v) : ""; };

type Cell = { l: string; v?: string; f: number; o?: { size?: number; font?: PDFFont } };

export interface PnwPayload { joint?: boolean; fields?: Record<string, unknown>; totals?: Record<string, unknown> }

export async function buildPnwPdfFromData(payload: PnwPayload): Promise<Uint8Array> {
  const fields = payload.fields ?? {};
  const totals = payload.totals ?? {};
  const g = (k: string) => sv(fields[k]);

  const doc = await PDFDocument.create();
  const F = await doc.embedFont(StandardFonts.Helvetica);
  const FB = await doc.embedFont(StandardFonts.HelveticaBold);

  const T = (pg: PDFPage, s: string, x: number, yTop: number, size: number, font: PDFFont = F, color = INK) => { if (s !== "") pg.drawText(String(s), { x, y: PH - yTop, size, font, color }); };
  const TR = (pg: PDFPage, s: string, xRight: number, yTop: number, size: number, font: PDFFont = F, color = INK) => { if (s !== "") { const w = font.widthOfTextAtSize(String(s), size); pg.drawText(String(s), { x: xRight - w, y: PH - yTop, size, font, color }); } };
  const rect = (pg: PDFPage, x: number, yTop: number, w: number, h: number, c: ReturnType<typeof rgb>) => pg.drawRectangle({ x, y: PH - yTop - h, width: w, height: h, color: c });
  const box = (pg: PDFPage, x: number, yTop: number, w: number, h: number) => pg.drawRectangle({ x, y: PH - yTop - h, width: w, height: h, borderColor: LINE, borderWidth: 0.6 });

  const header = (pg: PDFPage) => {
    rect(pg, 0, 0, PW, 78, HDR); rect(pg, 0, 78, PW, 4, GOLD);
    pg.drawSvgPath(MOUNTAIN, { x: 64, y: PH - 22, scale: 0.42, color: WHITE });
    T(pg, "Boreal", 112, 40, 18, FB, WHITE); T(pg, "Financial", 112, 62, 18, FB, WHITE);
    TR(pg, "PERSONAL STATEMENT OF AFFAIRS", PW - M, 40, 14, FB, WHITE);
    TR(pg, "Personal Net Worth Declaration", PW - M, 58, 9.5, F, rgb(0.78, 0.82, 0.88));
  };
  const bar = (pg: PDFPage, label: string, yTop: number) => { rect(pg, M, yTop, CW, 16, NAVY); T(pg, label.toUpperCase(), M + 7, yTop + 12, 9.5, FB, WHITE); return yTop + 16; };
  const cell = (pg: PDFPage, x: number, yTop: number, w: number, h: number, label: string, value: string, o: { size?: number; font?: PDFFont } = {}) => { box(pg, x, yTop, w, h); T(pg, label.toUpperCase(), x + 5, yTop + 9, 6, F, GREY); if (value !== "") T(pg, value, x + 5, yTop + 20, o.size ?? 9.5, o.font ?? FB, INK); };
  const row = (pg: PDFPage, yTop: number, h: number, cells: Cell[]) => { let x = M; for (const c of cells) { const w = CW * c.f; cell(pg, x, yTop, w, h, c.l, c.v ?? "", c.o ?? {}); x += w; } return yTop + h; };

  // ── PAGE 1 ──
  const p1 = doc.addPage([PW, PH]); header(p1); let y = 104;
  y = bar(p1, "Primary Party", y);
  y = row(p1, y, 26, [{ l: "Full Legal Name", v: g("primary_name"), f: 0.62 }, { l: "SIN", v: g("primary_sin"), f: 0.38 }]);
  y = row(p1, y, 26, [{ l: "Alternate Name(s)", v: g("primary_alt_names"), f: 0.5 }, { l: "Prior Name(s)", v: g("primary_prior_names"), f: 0.5 }]);
  y = row(p1, y, 26, [{ l: "Date of Birth", v: g("primary_dob"), f: 0.34 }, { l: "Marital Status", v: g("primary_marital"), f: 0.33 }, { l: "Dependents", v: g("primary_dependents"), f: 0.33 }]);
  y = row(p1, y, 26, [{ l: "Cell Phone", v: g("primary_cell"), f: 0.34 }, { l: "Home #", v: g("primary_home_phone"), f: 0.33 }, { l: "Work #", v: g("primary_work_phone"), f: 0.33 }]);
  y = row(p1, y, 26, [{ l: "Personal Email", v: g("primary_email"), f: 0.5, o: { size: 8.5 } }, { l: "Work Email", v: g("primary_work_email"), f: 0.5, o: { size: 8.5 } }]);
  y = row(p1, y, 26, [{ l: "Full Home Address", v: g("primary_home_address"), f: 0.5, o: { size: 8.5 } }, { l: "Physical Address (if different)", v: g("primary_physical_address"), f: 0.5, o: { size: 8.5 } }]);
  y += 8; y = bar(p1, "Annual Income — Sources", y);
  y = row(p1, y, 26, [{ l: "Employment", v: money(g("inc_employment_primary")), f: 0.34 }, { l: "Dividend", v: money(g("inc_dividend_primary")), f: 0.33 }, { l: "Rental", v: money(g("inc_rental_primary")), f: 0.33 }]);
  y = row(p1, y, 26, [{ l: "Investment", v: money(g("inc_investment_primary")), f: 0.34 }, { l: "Other", v: money(g("inc_other_1_primary")), f: 0.33 }, { l: "Other", v: money(g("inc_other_2_primary")), f: 0.33 }]);
  y += 8; y = bar(p1, "Spouse / Other Family Income (Monthly)", y);
  y = row(p1, y, 26, [{ l: "Spouse Legal Name", v: g("spouse_name"), f: 0.62 }, { l: "Spouse Mo. Income", v: money(g("spouse_monthly_income")), f: 0.38 }]);
  y = row(p1, y, 26, [{ l: "Spouse Employer", v: g("spouse_employer"), f: 0.62 }, { l: "How Long", v: g("spouse_employer_how_long"), f: 0.38 }]);
  y = row(p1, y, 26, [{ l: "Other Family Income (Source)", v: g("other_family_income_source"), f: 0.62 }, { l: "Mo. Income", v: money(g("other_family_income_monthly")), f: 0.38 }]);
  y += 8; y = bar(p1, "Personal References", y);
  for (const n of [1, 2, 3]) y = row(p1, y, 22, [{ l: `Reference ${n} — Name`, v: g(`ref${n}_name`), f: 0.28, o: { size: 8.5 } }, { l: "Relationship", v: g(`ref${n}_rel`), f: 0.22, o: { size: 8.5 } }, { l: "Address", v: g(`ref${n}_address`), f: 0.3, o: { size: 8 } }, { l: "Cell Phone", v: g(`ref${n}_phone`), f: 0.2, o: { size: 8.5 } }]);
  y += 8; y = bar(p1, "Disclosures", y);
  const DISC = ["Previous dealings with Boreal Financial (any division or subsidiary)?", "Ever filed for bankruptcy, consumer proposal, or any form of insolvency?", "Ever convicted of a criminal offence not pardoned?", "Income taxes for previous year(s) fully satisfied?", "Any legal actions, pending / looming actions or judgments against you?", "Are you a co-signor, guarantor or obligor to any other party's debts?"];
  const ansX = M + CW - 92;
  DISC.forEach((q, i) => { const h = 18; box(p1, M, y, CW, h); box(p1, ansX, y, 92, h); T(p1, q, M + 6, y + 12, 8, F, INK); T(p1, "PRIMARY", ansX + 6, y + 8, 6, F, GREY); T(p1, yn(g(`disc_${i}_primary`)) || "—", ansX + 6, y + 15.5, 8.5, FB, INK); y += h; });
  { const h = 30; box(p1, M, y, CW, h); T(p1, "ADDITIONAL DISCLOSURE / DETAILS", M + 6, y + 9, 6, F, GREY); T(p1, g("disclosure_details"), M + 6, y + 20, 8.5, F, INK); y += h; }
  { const h = 24; box(p1, M, y, CW, h); const init = g("primary_name").split(/\s+/).filter(Boolean).map((s) => s[0]).join("").slice(0, 3).toUpperCase(); T(p1, "INITIAL", M + 6, y + 9, 6, F, GREY); T(p1, init, M + 6, y + 20, 10, FB, INK); y += h; }

  // ── PAGE 2 ──
  const p2 = doc.addPage([PW, PH]); header(p2); let y2 = 104;
  y2 = bar(p2, "Assets & Liabilities", y2);
  const colW = CW / 2;
  rect(p2, M, y2, colW, 16, rgb(0.16, 0.27, 0.46)); rect(p2, M + colW, y2, colW, 16, rgb(0.16, 0.27, 0.46));
  T(p2, "ASSETS", M + 7, y2 + 12, 8.5, FB, WHITE); T(p2, "LIABILITIES", M + colW + 7, y2 + 12, 8.5, FB, WHITE); y2 += 16;
  const ASSETS: [string, string][] = [["Cash", "asset_cash"], ["RRSP", "asset_rrsp"], ["TFSA", "asset_tfsa"], ["Stocks / Bonds", "asset_stocks"], ["Accounts Receivable", "asset_ar"], ["Other (liquid)", "asset_liquid_other"], ["Vehicle 1", "asset_vehicle_1"], ["Vehicle 2", "asset_vehicle_2"], ["Vehicle 3", "asset_vehicle_3"], ["Real Estate 1", "asset_realestate_1"], ["Real Estate 2", "asset_realestate_2"], ["Real Estate 3", "asset_realestate_3"], ["Shareholder Loans", "asset_shareholder_loans"], ["Other (non-tangible)", "asset_nontangible_other"], ["Other Asset 1", "asset_other_1"], ["Other Asset 2", "asset_other_2"], ["Other Asset 3", "asset_other_3"]];
  const LIAB: [string, string][] = [["Credit Cards (total)", "liab_credit_cards"], ["RRSP Loans (total)", "liab_rrsp_loans"], ["Other Loans (total)", "liab_other_loans"], ["Stock Margin Debt", "liab_stock_margin"], ["Line of Credit (total)", "liab_loc"], ["Taxes Owing / CRA Debt", "liab_cra_debt"], ["Loan on Vehicle 1", "liab_vehicle_1"], ["Loan on Vehicle 2", "liab_vehicle_2"], ["Loan on Vehicle 3", "liab_vehicle_3"], ["Mortgage on Real Estate 1", "liab_mortgage_1"], ["Mortgage on Real Estate 2", "liab_mortgage_2"], ["Mortgage on Real Estate 3", "liab_mortgage_3"], ["Debt for Non-Tangible Assets", "liab_nontangible"], ["Lien on Other Asset 1", "liab_liens_1"], ["Lien on Other Asset 2", "liab_liens_2"], ["Lien on Other Asset 3", "liab_liens_3"], ["Lien on Other Asset 4", "liab_liens_4"]];
  const rh = 19, startY = y2;
  for (let i = 0; i < 17; i++) { const yy = startY + i * rh; if (i % 2 === 1) { rect(p2, M, yy, colW, rh, ROWBG); rect(p2, M + colW, yy, colW, rh, ROWBG); } box(p2, M, yy, colW, rh); box(p2, M + colW, yy, colW, rh); T(p2, ASSETS[i][0].toUpperCase(), M + 6, yy + 8, 6, F, GREY); TR(p2, money(g(ASSETS[i][1])), M + colW - 8, yy + 13, 9, FB, INK); T(p2, LIAB[i][0].toUpperCase(), M + colW + 6, yy + 8, 6, F, GREY); TR(p2, money(g(LIAB[i][1])), M + CW - 8, yy + 13, 9, FB, INK); }
  y2 = startY + 17 * rh;
  rect(p2, M, y2, colW, 18, rgb(0.90, 0.93, 0.97)); rect(p2, M + colW, y2, colW, 18, rgb(0.90, 0.93, 0.97)); box(p2, M, y2, colW, 18); box(p2, M + colW, y2, colW, 18);
  T(p2, "TOTAL ASSETS", M + 6, y2 + 8, 6.5, FB, INK); TR(p2, money(totals.assets), M + colW - 8, y2 + 13, 9.5, FB, INK);
  T(p2, "TOTAL LIABILITIES", M + colW + 6, y2 + 8, 6.5, FB, INK); TR(p2, money(totals.liabilities), M + CW - 8, y2 + 13, 9.5, FB, INK); y2 += 18;
  rect(p2, M, y2, CW, 22, HDR); T(p2, "NET WORTH  (Total Assets - Total Liabilities)", M + 8, y2 + 15, 10, FB, WHITE); TR(p2, money(totals.net), M + CW - 10, y2 + 15.5, 12, FB, GOLD); y2 += 22;
  y2 += 12; y2 = bar(p2, "Authorization & Warranty", y2); y2 += 6;
  const ENTITY = "Boreal Financial Corp.", CONTACT = "info@boreal.financial";
  const paras = [
    `The undersigned authorizes ${ENTITY} and its representatives, at any time and on an on-going basis, to obtain, verify, use, communicate with and disclose to third parties (including credit reporting agencies, credit exchanges, leasing brokers and credit grantors) any of my credit, financial and personal information that ${ENTITY} and its lending partners deem necessary to complete, service or enforce any lease, ancillary deed or transaction, including assignments and securitizations.`,
    `${ENTITY} may collect, hold, exchange and disclose your personal information to administer your contract and determine eligibility as permitted by law, and for internal statistical analysis. To review or correct your information, contact ${CONTACT}.`,
    `The undersigned warrants: I am a citizen or permanent resident of Canada or the USA; I have disclosed all claims (threatened, pending or looming) against me; there are no problems that would cause me to file for bankruptcy within 12 months; lenders are relying on this information in granting credit; and the above information is true and correct.`,
  ];
  const wrap = (s: string, size: number, maxW: number) => { const words = s.split(" "); const lines: string[] = []; let ln = ""; for (const w of words) { const t = ln ? ln + " " + w : w; if (F.widthOfTextAtSize(t, size) > maxW && ln) { lines.push(ln); ln = w; } else ln = t; } if (ln) lines.push(ln); return lines; };
  for (const para of paras) { for (const ln of wrap(para, 7.5, CW)) { T(p2, ln, M, y2 + 8, 7.5, F, rgb(0.25, 0.28, 0.34)); y2 += 10.5; } y2 += 5; }
  y2 += 14; const sigW = (CW - 30) / 2;
  p2.drawLine({ start: { x: M, y: PH - y2 }, end: { x: M + sigW, y: PH - y2 }, thickness: 0.8, color: rgb(0.3, 0.3, 0.3) });
  p2.drawLine({ start: { x: M + sigW + 30, y: PH - y2 }, end: { x: M + CW, y: PH - y2 }, thickness: 0.8, color: rgb(0.3, 0.3, 0.3) });
  T(p2, '{{t:s;r:y;o:"Owner 1";w:160;h:18;}}', M + 2, y2 - 3, 6, F, WHITE);
  // v_SIGNNOW_DROP_DATE_TAG: removed {{t:d;...}} date field - SignNow fieldextract rejects t:d (65656).
  T(p2, "Signature", M, y2 + 11, 8, F, GREY); T(p2, "Date", M + sigW + 30, y2 + 11, 8, F, GREY);

  return doc.save();
}

// DB-reading wrapper. Reads the latest submitted PNW response for the application.
export async function buildPnwPdf(applicationId: string): Promise<Uint8Array> {
  const res = await dbQuery<{ data: any }>(
    `SELECT data FROM application_form_responses
      WHERE application_id::text = ($1)::text
        AND doc_type IN ('net_worth_statement','personal_net_worth')
      ORDER BY submitted_at DESC NULLS LAST LIMIT 1`, [applicationId]);
  const payload = (res.rows[0]?.data ?? {}) as PnwPayload;
  return buildPnwPdfFromData(payload);
}
