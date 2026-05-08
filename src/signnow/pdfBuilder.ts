// BF_SERVER_BLOCK_v201_SIGNNOW_REAL_BUILD_v1
// Application PDF generator. Produces the document that gets sent to SignNow
// (real path) or stamped as already-signed (stub path). Single page, US Letter,
// business + applicant + funding sections, attestation, signature line.
//
// When real SignNow is enabled, you'll likely want to refine the layout to
// place signature/date fields at exact pixel coordinates SignNow can anchor
// onto. For now this is a clean human-readable rendering.

import { PDFDocument, StandardFonts, rgb } from "pdf-lib";

export type ApplicationPdfInputs = {
  applicationId: string;
  businessName: string | null;
  businessAddress: string | null;
  applicantName: string | null;
  applicantEmail: string | null;
  applicantPhone: string | null;
  requestedAmount: number | null;
  productCategory: string | null;
  purposeOfFunds: string | null;
  submittedAt: Date | null;
};

const PAGE_W = 612, PAGE_H = 792;
const MARGIN = 60;
const HEAD_FONT_SIZE = 18;
const SECTION_FONT_SIZE = 12;
const BODY_FONT_SIZE = 11;
const LINE_HEIGHT = 16;

function fmtMoney(n: number | null): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  return `$${Math.round(n).toLocaleString()}`;
}
function fmt(s: string | null): string { return s && s.trim().length > 0 ? s : "—"; }
function fmtDate(d: Date | null): string {
  if (!d) return "—";
  const dt = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(dt.getTime())) return "—";
  return dt.toISOString().slice(0, 10);
}

export async function buildApplicationPdf(inputs: ApplicationPdfInputs): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  pdf.setTitle(`Boreal Financial — Loan Application ${inputs.applicationId}`);
  pdf.setProducer("Boreal Financial");
  pdf.setCreator("Boreal Financial Application System");
  pdf.setCreationDate(new Date());

  const page = pdf.addPage([PAGE_W, PAGE_H]);
  const fontReg = await pdf.embedFont(StandardFonts.Helvetica);
  const fontBold = await pdf.embedFont(StandardFonts.HelveticaBold);

  let y = PAGE_H - MARGIN;

  page.drawText("Boreal Financial", {
    x: MARGIN, y, size: HEAD_FONT_SIZE, font: fontBold, color: rgb(0.06, 0.09, 0.16),
  });
  y -= 22;
  page.drawText("Loan Application", {
    x: MARGIN, y, size: 14, font: fontReg, color: rgb(0.29, 0.33, 0.41),
  });
  y -= 28;

  page.drawText(`Application ID: ${inputs.applicationId}`, {
    x: MARGIN, y, size: 10, font: fontReg, color: rgb(0.45, 0.50, 0.58),
  });
  y -= 14;
  page.drawText(`Submitted: ${fmtDate(inputs.submittedAt)}`, {
    x: MARGIN, y, size: 10, font: fontReg, color: rgb(0.45, 0.50, 0.58),
  });
  y -= 30;

  function section(title: string, rows: Array<[string, string]>) {
    page.drawText(title.toUpperCase(), {
      x: MARGIN, y, size: SECTION_FONT_SIZE, font: fontBold, color: rgb(0.10, 0.13, 0.20),
    });
    y -= 6;
    page.drawLine({
      start: { x: MARGIN, y }, end: { x: PAGE_W - MARGIN, y },
      thickness: 0.5, color: rgb(0.85, 0.87, 0.90),
    });
    y -= 14;
    for (const [label, value] of rows) {
      page.drawText(`${label}:`, {
        x: MARGIN, y, size: BODY_FONT_SIZE, font: fontBold, color: rgb(0.29, 0.33, 0.41),
      });
      page.drawText(value, {
        x: MARGIN + 130, y, size: BODY_FONT_SIZE, font: fontReg, color: rgb(0.06, 0.09, 0.16),
      });
      y -= LINE_HEIGHT;
    }
    y -= 10;
  }

  section("Business", [
    ["Legal Name", fmt(inputs.businessName)],
    ["Address", fmt(inputs.businessAddress)],
  ]);

  section("Applicant", [
    ["Name", fmt(inputs.applicantName)],
    ["Email", fmt(inputs.applicantEmail)],
    ["Phone", fmt(inputs.applicantPhone)],
  ]);

  section("Funding Request", [
    ["Amount", fmtMoney(inputs.requestedAmount)],
    ["Product", fmt(inputs.productCategory)],
    ["Purpose", fmt(inputs.purposeOfFunds)],
  ]);

  y -= 20;
  const att =
    "By signing below, the applicant attests that all information provided is true and accurate to " +
    "the best of their knowledge and authorizes Boreal Financial to verify this information with " +
    "third parties as needed for loan underwriting and lender placement.";
  for (const line of wrapText(att, 78)) {
    page.drawText(line, { x: MARGIN, y, size: 10, font: fontReg, color: rgb(0.29, 0.33, 0.41) });
    y -= 14;
  }
  y -= 30;

  page.drawText("Applicant Signature:", { x: MARGIN, y, size: BODY_FONT_SIZE, font: fontBold });
  page.drawLine({
    start: { x: MARGIN + 140, y: y - 2 }, end: { x: MARGIN + 380, y: y - 2 },
    thickness: 0.6, color: rgb(0.06, 0.09, 0.16),
  });
  y -= 30;

  page.drawText("Date:", { x: MARGIN, y, size: BODY_FONT_SIZE, font: fontBold });
  page.drawLine({
    start: { x: MARGIN + 140, y: y - 2 }, end: { x: MARGIN + 280, y: y - 2 },
    thickness: 0.6, color: rgb(0.06, 0.09, 0.16),
  });

  return pdf.save();
}

function wrapText(text: string, maxChars: number): string[] {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let cur = "";
  for (const w of words) {
    const next = cur ? `${cur} ${w}` : w;
    if (next.length > maxChars) {
      if (cur) lines.push(cur);
      cur = w;
    } else {
      cur = next;
    }
  }
  if (cur) lines.push(cur);
  return lines;
}
