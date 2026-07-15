// BF_SERVER_BLOCK_v_COLLATERAL_FORM_PDFS_v1 - branded Boreal PDF generators for
// the client-completed CMP collateral forms (Debt Stack, Equipment Collateral,
// Real Estate Collateral). Mirrors the Personal Net Worth template look (navy
// header, gold rule, vector mountain logo). No SignNow tags: these forms are
// submitted, rendered, and attached to the Documents list as-is.
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
const num = (v: unknown): number => { const n = Number(String(v ?? "").replace(/[^0-9.\-]/g, "")); return Number.isFinite(n) ? n : 0; };
const money = (v: unknown): string => { if (v === null || v === undefined || v === "") return ""; const n = Number(String(v).replace(/[^0-9.\-]/g, "")); return Number.isFinite(n) ? "$" + Math.round(n).toLocaleString() : sv(v); };
const yn = (v: unknown): string => { const s = sv(v).toLowerCase(); if (s === "yes" || s === "true" || s === "y") return "Yes"; if (s === "no" || s === "false" || s === "n") return "No"; return s ? sv(v) : ""; };

type Col = { label: string; frac: number; align?: "l" | "r" };
type CellOpt = { size?: number; bold?: boolean; align?: "l" | "r"; color?: ReturnType<typeof rgb> };

interface Canvas {
  doc: PDFDocument;
  F: PDFFont; FB: PDFFont;
  y(): number; setY(v: number): void;
  ensure(need: number): void;
  bar(label: string): void;
  gap(n: number): void;
  cellGrid(h: number, cells: Array<{ l: string; v?: string; f: number; o?: CellOpt }>): void;
  tableHead(cols: Col[]): void;
  tableRow(cols: Col[], vals: string[], o?: { zebra?: boolean; bold?: boolean }): void;
  page(): PDFPage;
  text(s: string, x: number, yTop: number, size: number, bold?: boolean, color?: ReturnType<typeof rgb>): void;
}

async function createCanvas(title: string, subtitle: string): Promise<Canvas> {
  const doc = await PDFDocument.create();
  const F = await doc.embedFont(StandardFonts.Helvetica);
  const FB = await doc.embedFont(StandardFonts.HelveticaBold);
  let pg: PDFPage = doc.addPage([PW, PH]);
  let y = 104;

  const T = (s: string, x: number, yTop: number, size: number, font: PDFFont = F, color = INK) => { if (s !== "") pg.drawText(String(s), { x, y: PH - yTop, size, font, color }); };
  const TR = (s: string, xRight: number, yTop: number, size: number, font: PDFFont = F, color = INK) => { if (s !== "") { const w = font.widthOfTextAtSize(String(s), size); pg.drawText(String(s), { x: xRight - w, y: PH - yTop, size, font, color }); } };
  const rect = (x: number, yTop: number, w: number, h: number, c: ReturnType<typeof rgb>) => pg.drawRectangle({ x, y: PH - yTop - h, width: w, height: h, color: c });
  const box = (x: number, yTop: number, w: number, h: number) => pg.drawRectangle({ x, y: PH - yTop - h, width: w, height: h, borderColor: LINE, borderWidth: 0.6 });

  const header = () => {
    rect(0, 0, PW, 78, HDR); rect(0, 78, PW, 4, GOLD);
    pg.drawSvgPath(MOUNTAIN, { x: 64, y: PH - 22, scale: 0.42, color: WHITE });
    T("Boreal", 112, 40, 18, FB, WHITE); T("Financial", 112, 62, 18, FB, WHITE);
    TR(title.toUpperCase(), PW - M, 40, 14, FB, WHITE);
    TR(subtitle, PW - M, 58, 9.5, F, rgb(0.78, 0.82, 0.88));
  };
  header();

  const newPage = () => { pg = doc.addPage([PW, PH]); header(); y = 104; };
  const ensure = (need: number) => { if (y + need > PH - 40) newPage(); };

  const fit = (value: string, w: number, size: number, font: PDFFont): { val: string; sz: number } => {
    const avail = w - 8; let sz = size;
    while (sz > 5.5 && font.widthOfTextAtSize(value, sz) > avail) sz -= 0.5;
    let val = value;
    if (font.widthOfTextAtSize(val, sz) > avail) { while (val.length > 1 && font.widthOfTextAtSize(val + "...", sz) > avail) val = val.slice(0, -1); val = val + "..."; }
    return { val, sz };
  };

  const bar = (label: string) => { ensure(24); rect(M, y, CW, 16, NAVY); T(label.toUpperCase(), M + 7, y + 12, 9.5, FB, WHITE); y += 16; };
  const gap = (n: number) => { y += n; };

  const cellGrid = (h: number, cells: Array<{ l: string; v?: string; f: number; o?: CellOpt }>) => {
    ensure(h); let x = M;
    for (const c of cells) {
      const w = CW * c.f;
      box(x, y, w, h);
      T(c.l.toUpperCase(), x + 5, y + 9, 6, F, GREY);
      const value = c.v ?? "";
      if (value !== "") { const font = c.o?.bold === false ? F : FB; const { val, sz } = fit(value, w - 2, c.o?.size ?? 9.5, font); T(val, x + 5, y + 20, sz, font, c.o?.color ?? INK); }
      x += w;
    }
    y += h;
  };

  const tableHead = (cols: Col[]) => {
    const h = 16; ensure(h + 18); rect(M, y, CW, h, NAVY);
    let x = M;
    for (const c of cols) { const w = CW * c.frac; if (c.align === "r") TR(c.label.toUpperCase(), x + w - 6, y + 11, 6.5, FB, WHITE); else T(c.label.toUpperCase(), x + 6, y + 11, 6.5, FB, WHITE); x += w; }
    y += h;
  };

  const tableRow = (cols: Col[], vals: string[], o: { zebra?: boolean; bold?: boolean } = {}) => {
    const h = 18; ensure(h);
    if (o.zebra) rect(M, y, CW, h, ROWBG);
    let x = M;
    for (let i = 0; i < cols.length; i++) {
      const c = cols[i]; if (!c) continue;
      const w = CW * c.frac; box(x, y, w, h);
      const raw = vals[i] ?? "";
      if (raw !== "") {
        const font = o.bold ? FB : F;
        const { val, sz } = fit(raw, w, 8, font);
        if (c.align === "r") TR(val, x + w - 6, y + 12, sz, font, INK); else T(val, x + 6, y + 12, sz, font, INK);
      }
      x += w;
    }
    y += h;
  };

  return {
    doc, F, FB,
    y: () => y, setY: (v) => { y = v; },
    ensure, bar, gap, cellGrid, tableHead, tableRow,
    page: () => pg,
    text: (s, x, yTop, size, bold, color) => T(s, x, yTop, size, bold ? FB : F, color ?? INK),
  };
}

// -- Debt Stack --
export interface DebtStackPayload { client_name?: string; rows?: Array<Record<string, unknown>>; notes?: string }

export async function buildDebtStackPdfFromData(payload: DebtStackPayload): Promise<Uint8Array> {
  const c = await createCanvas("Debt Stack", "Existing Business Debt Schedule");
  c.bar("Client");
  c.cellGrid(24, [{ l: "Client / Business Name", v: sv(payload.client_name), f: 1 }]);
  c.gap(8);
  c.bar("Debt Schedule");
  const cols: Col[] = [
    { label: "Lender / Creditor", frac: 0.16 }, { label: "Facility Type", frac: 0.13 },
    { label: "Original Amt", frac: 0.12, align: "r" }, { label: "Balance", frac: 0.12, align: "r" },
    { label: "Monthly", frac: 0.12, align: "r" }, { label: "Rate %", frac: 0.07, align: "r" },
    { label: "Maturity", frac: 0.12 }, { label: "Secured By", frac: 0.16 },
  ];
  c.tableHead(cols);
  const rows = Array.isArray(payload.rows) ? payload.rows : [];
  let totBal = 0, totMon = 0;
  rows.forEach((r, i) => {
    totBal += num(r.balance); totMon += num(r.monthly_payment);
    c.tableRow(cols, [
      sv(r.lender), sv(r.facility_type), money(r.original_amount), money(r.balance),
      money(r.monthly_payment), sv(r.rate), sv(r.maturity), sv(r.secured_by),
    ], { zebra: i % 2 === 1 });
  });
  c.tableRow(cols, ["TOTAL", "", "", money(totBal), money(totMon), "", "", ""], { bold: true });
  if (sv(payload.notes)) { c.gap(8); c.bar("Notes"); c.cellGrid(40, [{ l: "Notes", v: sv(payload.notes), f: 1, o: { bold: false, size: 8.5 } }]); }
  return c.doc.save();
}

// -- Equipment Collateral --
export interface EquipmentPayload { business_name?: string; rows?: Array<Record<string, unknown>>; notes?: string }

export async function buildEquipmentCollateralPdfFromData(payload: EquipmentPayload): Promise<Uint8Array> {
  const c = await createCanvas("Equipment Collateral", "Equipment Offered as Collateral");
  c.bar("Business");
  c.cellGrid(24, [{ l: "Business Name", v: sv(payload.business_name), f: 1 }]);
  c.gap(8);
  c.bar("Equipment Schedule");
  const cols: Col[] = [
    { label: "Year", frac: 0.06 }, { label: "Make", frac: 0.10 }, { label: "Model", frac: 0.11 },
    { label: "Description", frac: 0.17 }, { label: "Serial / VIN", frac: 0.13 }, { label: "Condition", frac: 0.09 },
    { label: "Est. Value", frac: 0.11, align: "r" }, { label: "Lienholder", frac: 0.12 }, { label: "Balance", frac: 0.11, align: "r" },
  ];
  c.tableHead(cols);
  const rows = Array.isArray(payload.rows) ? payload.rows : [];
  let totVal = 0, totBal = 0;
  rows.forEach((r, i) => {
    totVal += num(r.value); totBal += num(r.balance);
    c.tableRow(cols, [
      sv(r.year), sv(r.make), sv(r.model), sv(r.description), sv(r.serial), sv(r.condition),
      money(r.value), sv(r.lienholder), money(r.balance),
    ], { zebra: i % 2 === 1 });
  });
  c.tableRow(cols, ["TOTAL", "", "", "", "", "", money(totVal), "", money(totBal)], { bold: true });
  if (sv(payload.notes)) { c.gap(8); c.bar("Notes"); c.cellGrid(40, [{ l: "Notes", v: sv(payload.notes), f: 1, o: { bold: false, size: 8.5 } }]); }
  return c.doc.save();
}

// -- Real Estate Collateral --
export interface RealEstatePayload { properties?: Array<Record<string, unknown>> }

export async function buildRealEstateCollateralPdfFromData(payload: RealEstatePayload): Promise<Uint8Array> {
  const c = await createCanvas("Real Estate Collateral", "Real Property Offered as Collateral");
  const props = Array.isArray(payload.properties) ? payload.properties : [];
  const g = (p: Record<string, unknown>, k: string) => sv(p[k]);
  props.forEach((p, idx) => {
    c.gap(idx === 0 ? 0 : 10);
    c.bar(`Property ${idx + 1} - Address`);
    c.cellGrid(24, [{ l: "Street", v: g(p, "street"), f: 0.5, o: { size: 8.5 } }, { l: "City / Province", v: g(p, "city_province"), f: 0.5, o: { size: 8.5 } }]);
    c.cellGrid(24, [{ l: "Legal Address", v: g(p, "legal_address"), f: 0.7, o: { size: 8.5 } }, { l: "Property Type", v: g(p, "property_type"), f: 0.3 }]);
    c.bar("Ownership");
    c.cellGrid(24, [{ l: "Owner 1", v: g(p, "owner1"), f: 0.34 }, { l: "Marital", v: g(p, "owner1_marital"), f: 0.16 }, { l: "Owner 2", v: g(p, "owner2"), f: 0.34 }, { l: "Marital", v: g(p, "owner2_marital"), f: 0.16 }]);
    c.cellGrid(24, [{ l: "Owner 3", v: g(p, "owner3"), f: 0.34 }, { l: "Marital", v: g(p, "owner3_marital"), f: 0.16 }, { l: "Matrimonial Home?", v: yn(g(p, "matrimonial")), f: 0.25 }, { l: "Which", v: g(p, "matrimonial_which"), f: 0.25 }]);
    c.bar("Tenancy & Valuation");
    c.cellGrid(24, [{ l: "Rented?", v: yn(g(p, "rented")), f: 0.2 }, { l: "Rental Income (Mo.)", v: money(g(p, "rental_income_monthly")), f: 0.3 }, { l: "Renter Name(s)", v: g(p, "renter_names"), f: 0.5, o: { size: 8.5 } }]);
    c.cellGrid(24, [{ l: "Purchase Price", v: money(g(p, "purchase_price")), f: 0.25 }, { l: "When", v: g(p, "purchase_when"), f: 0.25 }, { l: "Present Value", v: money(g(p, "present_value")), f: 0.25 }, { l: "Value Method", v: g(p, "value_method"), f: 0.25 }]);
    c.bar("Mortgages & Charges");
    const mcols: Col[] = [
      { label: "Mortgage", frac: 0.12 }, { label: "Lender", frac: 0.22 }, { label: "Type", frac: 0.14 },
      { label: "Balance", frac: 0.16, align: "r" }, { label: "Charge", frac: 0.18 }, { label: "Payment", frac: 0.18, align: "r" },
    ];
    c.tableHead(mcols);
    ([1, 2, 3] as const).forEach((n, i) => {
      c.tableRow(mcols, [
        n === 1 ? "1st" : n === 2 ? "2nd" : "3rd",
        g(p, `m${n}_lender`), g(p, `m${n}_type`), money(g(p, `m${n}_balance`)), g(p, `m${n}_charge`), money(g(p, `m${n}_payment`)),
      ], { zebra: i % 2 === 1 });
    });
    c.bar("Taxes & Disclosures");
    c.cellGrid(24, [{ l: "Property Taxes Current?", v: g(p, "taxes_current"), f: 0.5 }, { l: "Other Charges", v: g(p, "other_charges"), f: 0.5, o: { size: 8.5 } }]);
    c.cellGrid(30, [{ l: "Other Charges - Details", v: g(p, "other_charges_details"), f: 1, o: { bold: false, size: 8.5 } }]);
    c.cellGrid(30, [{ l: "Other Disclosures", v: g(p, "other_disclosures"), f: 1, o: { bold: false, size: 8.5 } }]);
  });
  if (props.length === 0) { c.bar("Property"); c.cellGrid(24, [{ l: "No properties provided", v: "", f: 1 }]); }
  return c.doc.save();
}

// -- Dispatch + DB-reading wrapper --
export const COLLATERAL_FORM_DOC_TYPES = ["debt_stack", "equipment_list", "real_estate_collateral_disclosure"] as const;
export type CollateralFormDocType = (typeof COLLATERAL_FORM_DOC_TYPES)[number];

export function isCollateralFormDocType(docType: string): docType is CollateralFormDocType {
  return (COLLATERAL_FORM_DOC_TYPES as readonly string[]).includes(docType);
}

export async function buildCollateralFormPdfFromData(docType: string, data: unknown): Promise<Uint8Array> {
  const d = (data ?? {}) as Record<string, unknown>;
  if (docType === "debt_stack") return buildDebtStackPdfFromData(d);
  if (docType === "equipment_list") return buildEquipmentCollateralPdfFromData(d);
  if (docType === "real_estate_collateral_disclosure") return buildRealEstateCollateralPdfFromData(d);
  throw new Error(`unsupported collateral form doc_type: ${docType}`);
}

export async function buildCollateralFormPdf(applicationId: string, docType: string): Promise<Uint8Array> {
  const res = await dbQuery<{ data: any }>(
    `SELECT data FROM application_form_responses
      WHERE application_id::text = ($1)::text AND doc_type = $2
      ORDER BY submitted_at DESC NULLS LAST LIMIT 1`,
    [applicationId, docType],
  );
  return buildCollateralFormPdfFromData(docType, res.rows[0]?.data ?? {});
}
