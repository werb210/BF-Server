// BF_SERVER_MEDIA_FEE_AGREEMENT_v709
// BF_SERVER_MEDIA_AGREEMENT_ORIGINAL_v768 - v766 (one client's review changes) undone: every media client gets the
// original agreement wording again. One-off changes for a single client are handled outside the portal.
// The client-side Services Agreement for MEDIA files sent to a lender that does
// not pay Boreal (lender "signed broker agreement" box unchecked). Text is the
// reviewed Canadian Business Financing Services Agreement (MF LeBlanc version),
// reworded to 2630108 Alberta Ltd., trading as Boreal Financial ("BF"), Canada
// or the United States, Alberta law, and a single 2% fee on funding.
//
// Built like referrerAgreementPdfBuilder: values are printed directly and the
// only SignNow field is the client's signature (white field-extract tag). The
// date is baked server-side because t:d breaks fieldextract on this account.
import { PDFDocument, StandardFonts, rgb, PDFFont, PDFPage } from "pdf-lib";

export const MEDIA_FEE_AGREEMENT_ROLE = "Client";
export const MEDIA_FEE_RATE_TEXT = "Two Percent (2.0%)";

const PW = 612;
const PH = 792;
const M = 60;
const CW = PW - M * 2;
const WHITE = rgb(1, 1, 1);
const BLACK = rgb(0.08, 0.09, 0.11);
const GREY = rgb(0.42, 0.45, 0.5);

type Ctx = { doc: PDFDocument; page: PDFPage; y: number; F: PDFFont; B: PDFFont };

export type MediaFeeAgreementData = {
  agreementDate: string;
  companyName?: string | null;
  clientName?: string | null;
  street?: string | null;
  city?: string | null;
  provinceState?: string | null;
  country?: string | null;
  title?: string | null;
  approxAmount?: string | null;
};

// Paragraph text. Bold run first, then the body. Kept as data so the unit test
// can assert the agreed wording without parsing a PDF.
export function agreementParagraphs(d: MediaFeeAgreementData): Array<{ bold?: string; text: string }> {
  return [
    { text: "THIS SERVICES AGREEMENT is made in one (1) original copy as of " + d.agreementDate + " between 2630108 Alberta Ltd., trading as Boreal Financial (\"BF\") having an office at 450 Sparling Crt SW, Edmonton, Alberta T6X 1G9 and the Company identified in Schedule \"A\" (known as the \"Client\")." },
    { text: "WHEREAS the Client desires to obtain assistance from BF in financing or refinancing the Client presently residing/operating in Canada or the United States. BF will assist by procuring financing in the approximate amount listed in Schedule \"A\". This Agreement will set forth the terms of the engagement in respect of BF procuring financing on behalf of the Client." },
    { text: "THEREFORE, in consideration of the mutual covenants contained herein and for other good and valuable consideration, the receipt and sufficiency of which is hereby acknowledged, the parties agree as follows:" },
    { bold: "1. Definition.", text: "For the purpose of this Agreement, the term \"financing\" shall mean the procuring of a written commitment for any form of debt funding for the purpose of financing the Client." },
    { bold: "2. Services.", text: "The Client hereby engages BF as Exclusive Agent commencing on the date of signing of this Agreement. BF agrees to utilize its best efforts to obtain financing for the Client. BF's services shall include, without limitation, consultation with the Client, and preparation of any form of financing proposal which BF considers necessary to fulfill the Client's financing requirements. BF shall then proceed with making the appropriate contacts and submissions to consummate the financing. The Client fully understands that any decision regarding whether a lender will provide financing to the Client will be made by that lender and not by BF. Accordingly, the Client acknowledges that although BF will utilize its best efforts to obtain financing for the Client, there can be no assurance that those efforts will be successful." },
    { bold: "3. Disclosure.", text: "The Client shall ensure that all information provided to BF, in any manner and by any party on behalf of the Client, shall constitute full and accurate disclosure of all relevant facts. In the case of unresolved misrepresentation and/or non-disclosure of material information as determined by BF in its sole discretion, BF may terminate this Agreement." },
    { bold: "4. Remuneration.", text: "In consideration for the services provided by BF under this Agreement, the Client agrees to pay to BF according to Schedule \"A\" Fee Schedule." },
    { bold: "5. Direction to Pay.", text: "This Agreement shall serve as irrevocable direction and authorization for the lender, lawyer or closing agent to pay all fees due to BF as a first-ranking disbursement from the loan proceeds without any further instruction from the Client. This Agreement will be a part of any loan application submitted as a result of BF's services under this Agreement. Any resultant loan shall not be consummated unless and until the applicable fees/expenses are allocated for payment to BF." },
    { bold: "6. Term and Termination.", text: "This Agreement shall commence on the date of signing of this Agreement. This Agreement shall terminate on the 60th day following the date on which the Client provides to BF the requested information and documentation in form and content satisfactory to BF. If BF procures a financing commitment after the termination of this Agreement and the Client accepts it, this Agreement shall be deemed to be automatically extended by both parties to and including the date of acceptance and funding. The Client's obligations under Paragraphs 3, 4, 5, 7, 8, 9 and 10 hereof shall survive any termination of this Agreement and shall continue in full force and effect as specified in those paragraphs." },
    { bold: "7. Non-Circumvention.", text: "The Client shall not contact or transact with any lender contacted and/or disclosed by BF to the Client and/or disclosed by the Client to BF during the term of this Agreement without prior written consent from BF. If a financing is not consummated under this Agreement and, within one (1) year of the termination of this Agreement, the Client executes an agreement to obtain financing from a lender contacted and/or disclosed to the Client by BF or by the Client to BF, during the term of this Agreement, then that financing shall be deemed to have been arranged by BF under this Agreement and the Client shall pay the remuneration specified in Paragraph 4 of this Agreement." },
    { bold: "8. Information.", text: "The Client shall furnish at its expense any and all information that BF's lender may require. The Client affirms that all information, assertions, statements and representations made or furnished to BF hereunder are true and correct, whether made herewith or extraneously hereto and whether or not in writing. The Client acknowledges that BF shall rely on information provided by the Client and that BF shall be under no obligation to verify information provided by the Client." },
    { bold: "9. Indemnification.", text: "The Client shall defend, indemnify and hold harmless BF, its officers, directors, employees, and agents, from and against all losses or damages resulting from any and every claim which may arise from any misrepresentations or omissions of facts by the Client, its agent(s) or representative(s) to BF and/or from any other breach of any provision under this Agreement." },
    { bold: "10. Entire Agreement.", text: "This Agreement contains the entire understanding and agreement and supersedes all prior representations, warranties, understandings and agreements, whether written or oral, between the parties with respect to the subject matter hereof." },
    { bold: "11. Enurement and Assignment.", text: "This Agreement shall be binding upon and enure to the benefit of the parties hereto and their respective employees, representatives, administrators, heirs, executors, successors and assigns; provided, however, that this Agreement may not be assigned by the Client. The right to receive payments due from the Client may be assigned by BF." },
    { bold: "12. Amendment.", text: "This Agreement may be amended only by a written supplemental agreement executed by both parties." },
    { bold: "13. Waivers and Consents.", text: "No waiver of or consent under any provision of this Agreement shall be effective unless in writing and signed by the party against whom such waiver or consent is sought to be enforced. Neither the waiver by either party of any default in performance under or of any breach of any of the terms or conditions of this Agreement, nor the failure by either party to enforce any of the provisions of this Agreement, shall operate or be construed as a waiver of any subsequent default or breach." },
    { bold: "14. Notices.", text: "All notices hereunder shall be in writing and shall be delivered personally, by registered mail with Acknowledgment of Receipt or by any commercial courier providing equivalent confirmation of delivery." },
    { bold: "15. Severability.", text: "If any provision of this Agreement is declared by a court of competent jurisdiction to be invalid, unlawful or unenforceable, it shall be severed without affecting the validity and enforceability of the balance of this Agreement." },
    { bold: "16. Governing Law.", text: "This Agreement shall be interpreted in accordance with the laws of the Province of Alberta and the laws of Canada applicable therein." },
  ];
}

export function scheduleAFeeText(): string {
  return "Fee equal to " + MEDIA_FEE_RATE_TEXT + " of the gross total of any and all financing procured by BF or with BF's assistance is due upon funding and payable from the loan proceeds at funding in accordance with Paragraph 5.";
}

export const SCHEDULE_A_EFFECTIVE_TEXT = "This Agreement will become effective upon the Client's acknowledgment of acceptance of all terms, conditions and requirements hereunder by signing a copy of this Agreement and returning it to BF. IN WITNESS WHEREOF, this Agreement is executed by the parties as of the date written below.";

export function scheduleARows(d: MediaFeeAgreementData): Array<[string, string]> {
  const v = (s: string | null | undefined) => (s ?? "").trim();
  return [
    ["COMPANY NAME", v(d.companyName)],
    ["CLIENT NAME", v(d.clientName)],
    ["CLIENT STREET", v(d.street)],
    ["CLIENT CITY", v(d.city)],
    ["CLIENT PROVINCE / STATE", v(d.provinceState)],
    ["CLIENT COUNTRY", v(d.country)],
    ["TITLE IN COMPANY", v(d.title)],
    ["APPROXIMATE FINANCING AMOUNT", v(d.approxAmount)],
    ["DATE OF SIGNING", d.agreementDate],
  ];
}

function newPage(ctx: Ctx): void {
  ctx.page = ctx.doc.addPage([PW, PH]);
  ctx.y = M;
}

function ensure(ctx: Ctx, needed: number): void {
  if (ctx.y + needed > PH - M) newPage(ctx);
}

// pdf-lib StandardFonts are WinAnsi; anything outside it would throw. Client
// data comes from free-text fields, so strip what cannot be drawn.
export function pdfSafe(s: string): string {
  return String(s ?? "")
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, "\"")
    .replace(/[\u2013\u2014]/g, "-")
    .replace(/[^\x20-\x7E\u00A0-\u00FF]/g, "");
}

function wrapWords(words: string[], firstWidth: number, size: number, font: PDFFont, maxW: number): string[][] {
  const lines: string[][] = [];
  let cur: string[] = [];
  let width = firstWidth;
  for (const w of words) {
    const t = [...cur, w].join(" ");
    const avail = lines.length === 0 ? maxW - width : maxW;
    if (font.widthOfTextAtSize(t, size) > avail && cur.length) {
      lines.push(cur);
      cur = [w];
    } else cur.push(w);
  }
  if (cur.length) lines.push(cur);
  return lines;
}

function para(ctx: Ctx, bold: string | undefined, body: string, size = 9.5): void {
  const lead = 13;
  const boldText = bold ? pdfSafe(bold) + " " : "";
  const boldW = bold ? ctx.B.widthOfTextAtSize(boldText, size) : 0;
  const lines = wrapWords(pdfSafe(body).split(" "), boldW, size, ctx.F, CW);
  lines.forEach((words, i) => {
    ensure(ctx, lead);
    const y = PH - ctx.y;
    let x = M;
    if (i === 0 && bold) {
      ctx.page.drawText(boldText, { x, y, size, font: ctx.B, color: BLACK });
      x += boldW;
    }
    ctx.page.drawText(words.join(" "), { x, y, size, font: ctx.F, color: BLACK });
    ctx.y += lead;
  });
  ctx.y += 7;
}

export async function buildMediaFeeAgreementPdf(d: MediaFeeAgreementData): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const F = await doc.embedFont(StandardFonts.TimesRoman);
  const B = await doc.embedFont(StandardFonts.TimesRomanBold);
  const SIG = await doc.embedFont(StandardFonts.TimesRomanItalic); // BF_SERVER_FEE_COUNTERSIGN_v746
  const ctx: Ctx = { doc, page: doc.addPage([PW, PH]), y: M, F, B };

  ctx.page.drawText("SERVICES AGREEMENT", { x: M, y: PH - ctx.y, size: 13, font: B, color: BLACK });
  ctx.y += 24;
  for (const p of agreementParagraphs(d)) para(ctx, p.bold, p.text);

  newPage(ctx);
  ctx.page.drawText("Schedule A - Fee Schedule", { x: M, y: PH - ctx.y, size: 12, font: B, color: BLACK });
  ctx.y += 22;
  para(ctx, undefined, scheduleAFeeText());
  para(ctx, undefined, SCHEDULE_A_EFFECTIVE_TEXT);
  ctx.y += 6;

  const labelW = 190;
  for (const [label, value] of scheduleARows(d)) {
    ensure(ctx, 22);
    const top = PH - ctx.y;
    ctx.page.drawRectangle({ x: M, y: top - 6, width: CW, height: 20, borderColor: rgb(0.75, 0.77, 0.8), borderWidth: 0.6, color: rgb(0.95, 0.96, 0.97) });
    ctx.page.drawText(label, { x: M + 6, y: top, size: 9, font: B, color: BLACK });
    ctx.page.drawText(pdfSafe(value).slice(0, 70), { x: M + labelW, y: top, size: 9.5, font: F, color: BLACK });
    ctx.y += 20;
  }

  ensure(ctx, 120);
  ctx.y += 60;
  const sigW = (CW - 40) / 2;
  const lineY = PH - ctx.y;
  ctx.page.drawLine({ start: { x: M, y: lineY }, end: { x: M + sigW, y: lineY }, thickness: 0.8, color: rgb(0.3, 0.3, 0.3) });
  ctx.page.drawLine({ start: { x: M + sigW + 40, y: lineY }, end: { x: M + CW, y: lineY }, thickness: 0.8, color: rgb(0.3, 0.3, 0.3) });
  // Signature box sits above the line (h:20 box anchored top-left, extends down).
  ctx.page.drawText("{{t:s;r:y;o:\"" + MEDIA_FEE_AGREEMENT_ROLE + "\";w:200;h:20;}}", { x: M + 2, y: lineY + 22, size: 6, font: F, color: WHITE });
  ctx.page.drawText("2630108 Alberta Ltd., trading as Boreal Financial", { x: M + sigW + 40, y: lineY + 34, size: 9.5, font: B, color: BLACK });
  // BF_SERVER_FEE_COUNTERSIGN_v746 - Boreal signs its side when the agreement is issued, so the copy the
  // client signs is complete and nothing waits on a second signature. (Electronic signature, Alberta ETA.)
  ctx.page.drawText("/s/ Todd Werboweski", { x: M + sigW + 44, y: lineY + 6, size: 15, font: SIG, color: BLACK });
  ctx.y += 13;
  ctx.page.drawText("Signing Authority on behalf of Company, and Personally", { x: M, y: PH - ctx.y, size: 9, font: F, color: BLACK });
  ctx.page.drawText("Per: Todd Werboweski, Director", { x: M + sigW + 40, y: PH - ctx.y, size: 9, font: F, color: BLACK });
  ctx.page.drawText(pdfSafe("Signed electronically for Boreal Financial on " + d.agreementDate), { x: M + sigW + 40, y: PH - ctx.y - 14, size: 8, font: F, color: GREY });
  ctx.y += 14;
  ctx.page.drawText(pdfSafe(d.clientName ?? ""), { x: M, y: PH - ctx.y, size: 9, font: F, color: GREY });

  return doc.save();
}
