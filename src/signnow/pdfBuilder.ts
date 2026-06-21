// BF_SERVER_BLOCK_v202_SIGNNOW_FILLED_PDF_v1
// Renders the Boreal Financial application as a FILLED PDF (all wizard fields
// stamped in) for SignNow. Signature/date SignNow text-tags are placed as
// extraction anchors for the Owner 1 / Owner 2 roles (used by the embedded +
// email signing block). pdf-lib only.

import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";

export type PdfOwner = {
  label: string;
  firstName?: string | null; lastName?: string | null; ownership?: number | null;
  email?: string | null; phone?: string | null;
  street?: string | null; city?: string | null; province?: string | null; postal?: string | null;
  dob?: string | null; sin?: string | null; creditScore?: string | null;
};
export type ApplicationPdfInputs = {
  applicationId: string;
  product: { lookingFor?: string | null; category?: string | null; amountRequested?: number | null; equipmentValue?: number | null; location?: string | null };
  funding: { purposeOfFunds?: string | null; industry?: string | null; yearsInBusiness?: string | null; annualRevenue?: string | null; monthlyRevenue?: string | null; accountsReceivable?: number | null; fixedAssets?: number | null; availableCollateral?: number | null };
  business: { legalName?: string | null; dba?: string | null; structure?: string | null; inBusinessSince?: string | null; employees?: number | string | null; estimatedRevenue?: number | null; phone?: string | null; website?: string | null; address?: string | null; city?: string | null; province?: string | null; postal?: string | null };
  owners: PdfOwner[];
  // convenience for the send path / embedded session (derived from owners[0])
  applicantEmail?: string | null;
  applicantName?: string | null;
};

const NAVY = rgb(0.118, 0.227, 0.541), DARK = rgb(0.043, 0.122, 0.227);
const GREY = rgb(0.42, 0.45, 0.5), BLACK = rgb(0.1, 0.1, 0.1), LINE = rgb(0.79, 0.81, 0.84);
const PW = 612, PH = 792, M = 42, CW = PW - 2 * M;

function money(n: number | null | undefined): string { return (n === null || n === undefined || !Number.isFinite(Number(n))) ? "" : "$" + Math.round(Number(n)).toLocaleString(); }
function val(s: unknown): string { return (s === null || s === undefined || s === "") ? "" : String(s); }

type Cell = { label: string; value: unknown } | null;

export async function buildApplicationPdf(inputs: ApplicationPdfInputs): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const F = await doc.embedFont(StandardFonts.Helvetica);
  const FB = await doc.embedFont(StandardFonts.HelveticaBold);
  let page: PDFPage = doc.addPage([PW, PH]);
  let y = PH - M;

  const text = (s: string, x: number, yy: number, size: number, font: PDFFont, color = BLACK) => page.drawText(String(s), { x, y: yy, size, font, color });
  const rect = (x: number, yy: number, w: number, h: number, color: ReturnType<typeof rgb>) => page.drawRectangle({ x, y: yy, width: w, height: h, color });
  const cellbox = (x: number, yy: number, w: number, h: number) => page.drawRectangle({ x, y: yy, width: w, height: h, borderColor: LINE, borderWidth: 0.5 });
  const ensure = (need: number) => { if (y - need < M) { page = doc.addPage([PW, PH]); y = PH - M; } };

  // header
  text("BOREAL FINANCIAL", M, y - 16, 18, FB, DARK);
  text("boreal.financial", PW - M - 150, y - 4, 8, F, DARK);
  text("info@boreal.financial", PW - M - 150, y - 14, 8, F, DARK);
  text("submissions@boreal.financial", PW - M - 150, y - 24, 8, F, DARK);
  y -= 30;
  page.drawLine({ start: { x: M, y }, end: { x: PW - M, y }, thickness: 1.2, color: NAVY });
  y -= 6;
  rect(M, y - 18, CW, 18, DARK); text("BUSINESS FUNDING APPLICATION", M + 8, y - 13, 11, FB, rgb(1, 1, 1)); y -= 26;

  const bar = (t: string) => { ensure(40); rect(M, y - 15, CW, 15, NAVY); text(t.toUpperCase(), M + 6, y - 11, 9, FB, rgb(1, 1, 1)); y -= 15; };
  const row = (cells: Cell[], h = 30) => {
    ensure(h + 4);
    const cols = cells.length, w = CW / cols;
    for (let i = 0; i < cols; i++) {
      const cx = M + i * w; cellbox(cx, y - h, w, h);
      const c = cells[i];
      if (c) { text(c.label.toUpperCase(), cx + 4, y - 9, 6, F, GREY); const v = val(c.value); if (v) text(v, cx + 4, y - 22, 9, FB, BLACK); }
    }
    y -= h;
  };

  const p = inputs.product, fu = inputs.funding, b = inputs.business;
  bar("Funding Request");
  row([{ label: "Looking For", value: p.lookingFor }, { label: "Product Category", value: p.category }, { label: "Business Location", value: p.location }]);
  row([{ label: "Amount Requested ($)", value: money(p.amountRequested) }, { label: "Equipment Value ($)", value: money(p.equipmentValue) }, { label: "Years in Business", value: fu.yearsInBusiness }]);
  row([{ label: "Purpose of Funds", value: fu.purposeOfFunds }]);
  row([{ label: "Industry", value: fu.industry }, { label: "Annual Revenue (last 12 mo)", value: fu.annualRevenue }, { label: "Monthly Revenue", value: fu.monthlyRevenue }]);
  row([{ label: "Accounts Receivable ($)", value: money(fu.accountsReceivable) }, { label: "Fixed Assets ($)", value: money(fu.fixedAssets) }, { label: "Available Collateral ($)", value: money(fu.availableCollateral) }]);

  y -= 6; bar("Business Details");
  row([{ label: "Legal Business Name", value: b.legalName }, { label: "Operating As (DBA)", value: b.dba }]);
  row([{ label: "Business Structure", value: b.structure }, { label: "In Business Since", value: b.inBusinessSince }, { label: "Employees", value: b.employees }]);
  row([{ label: "Estimated Annual Revenue ($)", value: money(b.estimatedRevenue) }, { label: "Business Phone", value: b.phone }, { label: "Website", value: b.website }]);
  row([{ label: "Business Address", value: b.address }]);
  row([{ label: "City", value: b.city }, { label: "Province / State", value: b.province }, { label: "Postal / ZIP", value: b.postal }]);

  for (const o of inputs.owners) {
    y -= 6; bar(o.label);
    row([{ label: "First Name", value: o.firstName }, { label: "Last Name", value: o.lastName }, { label: "Ownership %", value: o.ownership != null ? o.ownership + "%" : "" }]);
    row([{ label: "Email", value: o.email }, { label: "Mobile Phone", value: o.phone }]);
    row([{ label: "Home Address", value: o.street }]);
    row([{ label: "City", value: o.city }, { label: "Province / State", value: o.province }, { label: "Postal / ZIP", value: o.postal }]);
    row([{ label: "Date of Birth", value: o.dob }, { label: "SIN / SSN", value: o.sin }, { label: "Credit Score (self-reported)", value: o.creditScore }]);
  }

  // consent
  y -= 8; ensure(140);
  const consent = "The undersigned certifies the above information is true, correct and complete and authorizes Boreal Financial and its representatives to obtain, verify, use and disclose to third parties (including credit reporting agencies and lenders) any credit, financial and personal information necessary to assess, service or enforce this application, in accordance with applicable privacy law (PIPEDA). Contact info@boreal.financial to review or correct your information.";
  const words = consent.split(" "); let line = ""; const grey = rgb(0.22, 0.25, 0.3);
  for (const w of words) { const t = line ? line + " " + w : w; if (F.widthOfTextAtSize(t, 7) > CW) { text(line, M, y, 7, F, grey); y -= 9; line = w; } else line = t; }
  if (line) { text(line, M, y, 7, F, grey); y -= 9; }
  y -= 10;

  bar("Signatures — all owners must sign"); y -= 4;
  const sigRow = (role: string, leftX: number) => {
    cellbox(leftX, y - 40, CW / 2 - 4, 40);
    text(role.toUpperCase() + " — SIGNATURE", leftX + 4, y - 9, 6, F, GREY);
    text(`{{t:s;r:y;o:"${role}";w:120;h:16;}}`, leftX + 4, y - 30, 6, F, rgb(1, 1, 1));
    text(`{{t:t;r:y;o:"${role}";w:70;h:16;}}`, leftX + 150, y - 30, 6, F, rgb(1, 1, 1));
  };
  ensure(44);
  sigRow("Owner 1", M);
  sigRow("Owner 2", M + CW / 2 + 4);
  y -= 40;

  return doc.save();
}
