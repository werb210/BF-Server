// BF_SERVER_v968_PGI_REP_AGREEMENT - the Introducer Agreement an outside PGI rep signs when staff add them in the
// Insurance silo's Reps screen. Same SignNow mechanics as the referrer agreement (invisible text tags for the
// "Rep" role, Boreal's signature applied when issued); the wording is its own:
//   - the rep is paid for introductions only and does not sell, quote or negotiate insurance;
//   - 20% of the commission Boreal Risk Management actually receives on PGI business from each bank, lender or
//     broker the rep introduced, for as long as that party does business with Boreal and this agreement is in force;
//   - payment stops when the agreement ends, for any reason; paid in USD by wire or ACH within 30 days of receipt.
import { PDFDocument, StandardFonts, rgb, PDFFont, PDFPage } from "pdf-lib";

const ROLE = "Rep";
const PW = 612;
const PH = 792;
const M = 54;
const CW = PW - M * 2;
const WHITE = rgb(1, 1, 1);
const BLACK = rgb(0.1, 0.12, 0.16);
const GREY = rgb(0.42, 0.45, 0.5);
const NAVY = rgb(0.05, 0.11, 0.25);

type Ctx = { doc: PDFDocument; page: PDFPage; y: number; F: PDFFont; B: PDFFont };

function newPage(ctx: Ctx): void {
  ctx.page = ctx.doc.addPage([PW, PH]);
  ctx.y = M;
}

function ensure(ctx: Ctx, needed: number): void {
  if (ctx.y + needed > PH - M) newPage(ctx);
}

function text(ctx: Ctx, s: string, size: number, font: PDFFont, color = BLACK, indent = 0): void {
  ctx.page.drawText(s, { x: M + indent, y: PH - ctx.y, size, font, color });
}

function wrap(s: string, size: number, font: PDFFont, maxW: number): string[] {
  const words = s.split(" ");
  const lines: string[] = [];
  let ln = "";
  for (const w of words) {
    const t = ln ? `${ln} ${w}` : w;
    if (font.widthOfTextAtSize(t, size) > maxW && ln) {
      lines.push(ln);
      ln = w;
    } else ln = t;
  }
  if (ln) lines.push(ln);
  return lines;
}

function para(ctx: Ctx, s: string, size = 8.5, indent = 0, color = BLACK): void {
  const lines = wrap(s, size, ctx.F, CW - indent);
  for (const ln of lines) {
    ensure(ctx, 12);
    text(ctx, ln, size, ctx.F, color, indent);
    ctx.y += size * 1.35;
  }
  ctx.y += 4;
}

function heading(ctx: Ctx, s: string): void {
  ensure(ctx, 26);
  ctx.y += 6;
  text(ctx, s, 10, ctx.B, NAVY);
  ctx.y += 15;
}

// A labelled line with an invisible SignNow text field sitting on it.
function fieldLine(ctx: Ctx, label: string, tag: string, required: boolean, value?: string | null): void {
  ensure(ctx, 30);
  text(ctx, label, 8, ctx.F, GREY);
  ctx.y += 13;
  ctx.page.drawLine({
    start: { x: M, y: PH - ctx.y },
    end: { x: M + CW * 0.72, y: PH - ctx.y },
    thickness: 0.7,
    color: rgb(0.6, 0.62, 0.66),
  });
  // BF_SERVER_REFERRER_AGREEMENT_BAKE_v1 - print the value directly when we have it
  // (nothing for the referrer to fill); otherwise draw the invisible field tag.
  if (value && String(value).trim()) {
    ctx.page.drawText(String(value).trim(), { x: M + 2, y: PH - ctx.y + 3, size: 9, font: ctx.F, color: BLACK });
  } else {
    text(ctx, tag, 6, ctx.F, WHITE, 2);
  }
  ctx.y += 18;
  void required;
}

export type PgiRepAgreementData = { fullName: string; company?: string | null; email: string; phone?: string | null };

export const PGI_REP_AGREEMENT_VERSION = "2026-11-16";
export const PGI_REP_SHARE_PERCENT = 20;

/** The agreement's clauses, in order. Exported so the wording can be tested and shown without rendering a PDF. */
export const PGI_REP_AGREEMENT_SECTIONS: Array<{ heading: string; paragraphs: string[]; bullets?: string[] }> = [
  { heading: "1. Purpose and Relationship", paragraphs: [
    '1. Boreal arranges Personal Guarantee Insurance ("PGI") for business owners by introducing them, and the banks, lenders and brokers that serve them, to the insurance program\'s managing general agent and insurer (the "Carrier"). The Introducer wishes to introduce banks, lenders, loan brokers and similar businesses (each an "Introduced Party") to Boreal, and Boreal wishes to pay the Introducer for introductions that lead to PGI business, on the terms of this Agreement.',
    "2. The Introducer is an independent contractor. Nothing in this Agreement creates a partnership, joint venture, agency, franchise or employment relationship. The Introducer has no authority to bind Boreal or the Carrier.",
    "3. This Agreement is non-exclusive. Each Party remains free to work with others.",
  ] },
  { heading: "2. Introductions Only", paragraphs: [
    "4. The Introducer's role is limited to introducing an Introduced Party to Boreal. The Introducer is paid for introductions only. The Introducer will not sell, solicit, quote, negotiate, bind or advise on insurance; will not discuss or explain policy terms, coverage, premiums or eligibility; will not collect premiums or any other funds; and will not hold itself out as an insurance agent, broker or producer or as a representative of the Carrier.",
    "5. All discussion of the insurance itself, all quotes and all applications are handled by Boreal and the Carrier. The Introducer may share marketing material supplied by Boreal, unaltered, and may share the Introducer's own page and links supplied by Boreal.",
    "6. Nothing in this Agreement requires or permits the Introducer to do anything for which an insurance licence is required where the Introducer or the Introduced Party is located. If the law of a state, province or territory does not allow the Introducer to be paid as set out in Section 4 for a particular Introduced Party, no amount is payable for that Introduced Party and the Parties will discuss in good faith a lawful alternative.",
  ] },
  { heading: "3. Qualifying Introductions", paragraphs: [
    "7. An introduction qualifies when (a) the Introducer records the Introduced Party through the Introducer's page or another method Boreal designates, or Boreal confirms the introduction in writing (email is sufficient); (b) at that time the Introduced Party is not already a client, partner, applicant or active lead of Boreal and has not been introduced by someone else; and (c) the Introduced Party afterwards does PGI business with Boreal. Boreal's records determine these points, acting reasonably.",
    "8. Boreal and the Carrier have sole discretion over whether to work with an Introduced Party and over all underwriting, pricing and coverage decisions. Neither is obliged to pursue any introduction.",
  ] },
  { heading: "4. Payment", paragraphs: [
    `9. Rate. For each qualifying Introduced Party, Boreal will pay the Introducer twenty percent (${20}%) of the commission that Boreal actually receives and retains from the Carrier on PGI policies placed through that Introduced Party, including on policies for that Introduced Party's own borrowers and clients and on renewals of those policies. There is no cap on the volume of an Introduced Party's business to which this applies.`,
    "10. Duration. The Introducer is paid under Section 9 for as long as the Introduced Party continues to do PGI business with Boreal and this Agreement remains in force. When this Agreement ends, for any reason, the Introducer's right to payment ends with it, except for amounts already earned under Section 11 before the end date.",
    "11. When earned. An amount is earned only when Boreal has actually received the corresponding commission from the Carrier. Nothing is payable on business that is not placed, or on which Boreal receives no commission.",
    "12. Payment. Boreal will pay earned amounts in United States dollars by wire or ACH to the account the Introducer designates in writing, within thirty (30) days after Boreal receives the corresponding commission, with a statement showing how the amount was calculated. The Introducer is responsible for keeping its payment details current.",
    "13. Adjustments. If a policy is cancelled, rescinded or refunded so that Boreal must repay or does not keep its commission, the amount paid to the Introducer on that policy is repayable to Boreal and may be set off against later payments.",
    "14. Taxes. Amounts are exclusive of applicable taxes. The Introducer is solely responsible for all taxes on amounts it receives and for its own filings, and will provide any tax form Boreal reasonably requests (for example a Form W-9 or W-8).",
  ] },
  { heading: "5. Introducer Obligations", paragraphs: ["The Introducer will:"], bullets: [
    "act only within Section 2, and make no promise, representation or commitment on behalf of Boreal or the Carrier;",
    "describe PGI only as optional for the borrower and never as a condition of any loan;",
    "obtain an Introduced Party's consent before passing its contact details to Boreal, and comply with all laws that apply to its own activities, including privacy, anti-spam and telemarketing laws;",
    "not use the name, logo or trademarks of Boreal or the Carrier except in material Boreal supplies or approves in writing;",
    "not charge an Introduced Party, or any borrower, a fee in connection with an introduction; and",
    "act honestly and in good faith and do nothing that could reasonably harm the reputation of Boreal or the Carrier.",
  ] },
  { heading: "6. Privacy and Confidentiality", paragraphs: [
    "15. Each Party will keep confidential the other Party's non-public information and that of any Introduced Party, use it only to perform this Agreement, and protect it with reasonable safeguards. This continues after this Agreement ends.",
    "16. Once an introduction is made, Boreal is responsible for the relationship with the Introduced Party and for its own communications.",
  ] },
  { heading: "7. Term and Termination", paragraphs: [
    "17. This Agreement begins on the Effective Date and continues until ended. Either Party may end it at any time, with or without cause, on written notice (email is sufficient).",
    "18. Sections on confidentiality, taxes, adjustments, limitation of liability, indemnity and governing law survive the end of this Agreement.",
  ] },
  { heading: "8. Representations", paragraphs: [
    "19. Each Party represents that it has authority to enter into this Agreement. The Introducer represents that it is not prohibited by law, contract, or any licensing or regulatory requirement from making introductions or receiving payment under this Agreement, and will tell Boreal promptly if that changes.",
  ] },
  { heading: "9. Limitation of Liability and Indemnity", paragraphs: [
    "20. To the maximum extent permitted by law, neither Party is liable to the other for indirect, incidental, special or consequential damages. Boreal's total liability under this Agreement will not exceed the total amounts paid to the Introducer in the twelve (12) months before the event giving rise to the claim.",
    "21. The Introducer will indemnify Boreal against claims, losses and reasonable costs arising from the Introducer's breach of this Agreement, its misrepresentations, or its violation of any law.",
  ] },
  { heading: "10. General", paragraphs: [
    "22. Governing law. This Agreement is governed by the laws of the Province of Alberta and the federal laws of Canada applicable there, and the Parties attorn to the courts of Alberta.",
    "23. Entire agreement. This Agreement is the entire agreement between the Parties on its subject and replaces any prior understanding. It may be amended only in writing signed by both Parties.",
    "24. Assignment. The Introducer may not assign this Agreement without Boreal's prior written consent. Boreal may assign it to an affiliate or successor.",
    "25. Severability and electronic signature. If any provision is unenforceable, the rest remains in effect. This Agreement may be signed electronically and in counterparts.",
  ] },
];

export async function buildPgiRepAgreementPdf(data: PgiRepAgreementData): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const F = await doc.embedFont(StandardFonts.Helvetica);
  const B = await doc.embedFont(StandardFonts.HelveticaBold);
  const SIG = await doc.embedFont(StandardFonts.TimesRomanItalic);
  const ctx: Ctx = { doc, page: doc.addPage([PW, PH]), y: M, F, B };

  text(ctx, "BOREAL RISK MANAGEMENT", 13, B, NAVY);
  ctx.y += 16;
  text(ctx, "PERSONAL GUARANTEE INSURANCE - INTRODUCER AGREEMENT", 11, B, BLACK);
  ctx.y += 18;
  para(ctx, 'This Introducer Agreement (the "Agreement") is entered into as of the date of the last signature below (the "Effective Date") between: 2630108 Alberta Ltd., carrying on business as Boreal Risk Management, with its principal office at 450 Sparling Crt SW, Edmonton, Alberta T6X 1G9, Canada ("Boreal"); and the individual or entity identified in the signature block below (the "Introducer"). Boreal and the Introducer are each a "Party" and together the "Parties."');
  for (const s of PGI_REP_AGREEMENT_SECTIONS) {
    heading(ctx, s.heading);
    for (const p of s.paragraphs) para(ctx, p);
    for (const b of s.bullets ?? []) para(ctx, `-  ${b}`, 8.5, 10);
  }

  newPage(ctx);
  text(ctx, "Acceptance and Signatures", 12, B, NAVY);
  ctx.y += 18;
  para(ctx, "By signing below, the Introducer agrees to the terms of this Introducer Agreement.", 8.5, 0, GREY);
  ctx.y += 4;
  text(ctx, "INTRODUCER", 9.5, B, BLACK);
  ctx.y += 18;
  fieldLine(ctx, "Full name", `{{t:t;r:y;o:"${ROLE}";l:"Full name";w:230;h:16;}}`, true, data.fullName);
  fieldLine(ctx, "Company (if any)", `{{t:t;r:n;o:"${ROLE}";l:"Company";w:230;h:16;}}`, false, data.company || "-");
  fieldLine(ctx, "Email", `{{t:t;r:y;o:"${ROLE}";l:"Email";w:230;h:16;}}`, true, data.email);
  fieldLine(ctx, "Phone", `{{t:t;r:n;o:"${ROLE}";l:"Phone";w:230;h:16;}}`, false, data.phone || "-");

  ensure(ctx, 60);
  ctx.y += 10;
  const sigW = (CW - 40) / 2;
  ctx.page.drawLine({ start: { x: M, y: PH - ctx.y }, end: { x: M + sigW, y: PH - ctx.y }, thickness: 0.8, color: rgb(0.3, 0.3, 0.3) });
  ctx.page.drawLine({ start: { x: M + sigW + 40, y: PH - ctx.y }, end: { x: M + CW, y: PH - ctx.y }, thickness: 0.8, color: rgb(0.3, 0.3, 0.3) });
  ctx.page.drawText(`{{t:s;r:y;o:"${ROLE}";w:170;h:20;}}`, { x: M + 2, y: PH - ctx.y + 22, size: 6, font: F, color: WHITE });
  const today = new Intl.DateTimeFormat("en-US", { year: "numeric", month: "2-digit", day: "2-digit", timeZone: "America/Regina" }).format(new Date());
  ctx.page.drawText(today, { x: M + sigW + 42, y: PH - ctx.y + 3, size: 9, font: F, color: BLACK });
  ctx.y += 12;
  text(ctx, "Signature", 8, F, GREY);
  ctx.page.drawText("Date", { x: M + sigW + 40, y: PH - ctx.y, size: 8, font: F, color: GREY });
  ctx.y += 30;

  text(ctx, "BOREAL RISK MANAGEMENT (2630108 ALBERTA LTD.)", 9.5, B, BLACK);
  ctx.y += 22;
  text(ctx, "/s/ Todd Werboweski", 14, SIG, BLACK);
  ctx.y += 14;
  text(ctx, "Per: Todd Werboweski, Director", 8.5, F, BLACK);
  ctx.y += 12;
  para(ctx, "Signed electronically for Boreal Risk Management on " + new Intl.DateTimeFormat("en-US", { year: "numeric", month: "long", day: "numeric", timeZone: "America/Regina" }).format(new Date()) + ".", 8, 0, GREY);
  ctx.y += 10;
  text(ctx, "Boreal Risk Management | 450 Sparling Crt SW, Edmonton, AB T6X 1G9, Canada | Agreement version " + PGI_REP_AGREEMENT_VERSION, 7.5, F, GREY);
  return doc.save();
}
