// BF_SERVER_REFERRER_TEMPLATE_GEN_v1
// Builds the Boreal Referral Partner Agreement as a PDF with SignNow field-extract text
// tags embedded in white (invisible when rendered, parsed by POST /document/fieldextract).
// Uploading this PDF with fieldextract, then converting it to a template, produces the
// template that SIGNNOW_REFERRER_TEMPLATE_ID points at - no manual dashboard work.
//
// Tag anatomy (matches accordPdfBuilder / pnwPdfBuilder):
//   t: field type      s = signature, t = text
//   r: required        y | n
//   o: role name       must match SIGNNOW_REFERRER_ROLE_NAME (default "Referrer")
//   l: label
//   w:/h: size in pt
// The date field is t:t with l:"Date" on purpose. A real date field (t:d) breaks this
// account's fieldextract with error 65656; dates are stamped server-side instead.
import { PDFDocument, StandardFonts, rgb, PDFFont, PDFPage } from "pdf-lib";

const ROLE = "Referrer";
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

export type ReferrerAgreementData = {
  fullName?: string | null;
  company?: string | null;
  email?: string | null;
  phone?: string | null;
  street?: string | null;
  cityProvincePostal?: string | null;
  payoutEmail?: string | null;
};

export async function buildReferrerAgreementPdf(data?: ReferrerAgreementData): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const F = await doc.embedFont(StandardFonts.Helvetica);
  const B = await doc.embedFont(StandardFonts.HelveticaBold);
  const ctx: Ctx = { doc, page: doc.addPage([PW, PH]), y: M, F, B };

  text(ctx, "BOREAL FINANCIAL GROUP", 13, B, NAVY);
  ctx.y += 18;
  text(ctx, "REFERRAL PARTNER AGREEMENT", 11, B, BLACK);
  ctx.y += 20;

  para(ctx, 'This Referral Partner Agreement (the "Agreement") is entered into as of the date of the last signature below (the "Effective Date") between: Boreal Financial Group, a commercial lending marketplace with its principal office at 450 Sparling Crt SW, Edmonton, Alberta T6X 1G9 ("Boreal"); and the individual or entity identified in the signature block below (the "Referral Partner"). Boreal and the Referral Partner are each a "Party" and together the "Parties."');

  heading(ctx, "1. Purpose and Relationship");
  para(ctx, '1. The Referral Partner wishes to refer prospective borrowers and business clients (each a "Referred Client") to Boreal so that Boreal may offer them commercial financing and related services. Boreal wishes to pay the Referral Partner a commission for qualifying referrals on the terms set out in this Agreement.');
  para(ctx, "2. The Referral Partner is an independent contractor. Nothing in this Agreement creates any partnership, joint venture, agency, franchise, or employment relationship between the Parties. The Referral Partner has no authority to bind Boreal, to negotiate or approve financing, to make representations on Boreal's behalf, or to collect any funds from a Referred Client.");
  para(ctx, "3. This Agreement is non-exclusive. Each Party remains free to work with other partners, lenders, and clients.");

  heading(ctx, "2. Submitting Referrals");
  para(ctx, "4. The Referral Partner will submit referrals through the referral portal or other method designated by Boreal, providing the Referred Client's name and contact details and any other information reasonably requested.");
  para(ctx, "5. Before submitting a referral, the Referral Partner must have obtained the Referred Client's consent to be contacted by Boreal and to have their information shared with Boreal for the purpose of arranging financing.");
  para(ctx, "6. A referral is only eligible for commission if, at the time it is submitted, the Referred Client is not already an active applicant, client, or lead of Boreal, and has not been referred to Boreal by another partner. Boreal's records determine eligibility, acting reasonably.");
  para(ctx, "7. Boreal has sole discretion over whether to accept a Referred Client, what financing (if any) to offer, and the terms of any financing. Boreal is under no obligation to pursue or fund any referral.");

  heading(ctx, "3. Commission");
  para(ctx, "8. Rate. For each Referred Client that Boreal funds, Boreal will pay the Referral Partner a commission equal to twenty percent (20%) of the net commission or fee actually received and retained by Boreal from the lender or funding source in connection with that funded transaction.");
  para(ctx, "9. When earned. A commission is earned only once the Referred Client's financing has closed and funded and Boreal has actually received its corresponding commission or fee. No commission is payable on referrals that do not fund, or where Boreal receives no commission or fee.");
  para(ctx, "10. Payment. Boreal will pay earned commissions within thirty (30) days after Boreal receives the corresponding commission or fee, by Interac e-Transfer to the payout email provided by the Referral Partner (or another method agreed in writing). The Referral Partner is responsible for keeping their payout details current.");
  para(ctx, "11. Chargebacks. If a funded transaction is later cancelled, unwound, refunded, or clawed back such that Boreal must repay or forgoes its commission or fee, any commission paid to the Referral Partner on that transaction is repayable to Boreal and may be set off against future commissions.");
  para(ctx, "12. Taxes. Commissions are exclusive of applicable taxes. The Referral Partner is solely responsible for all taxes arising from commissions received, including any GST/HST and income tax, and for their own remittances and filings.");

  heading(ctx, "4. Referral Partner Obligations");
  para(ctx, "The Referral Partner will:");
  for (const b of [
    "provide accurate information and not misrepresent Boreal, its products, rates, approval likelihood, or any financing terms;",
    "not make any promise, guarantee, or commitment to a Referred Client on Boreal's behalf;",
    "comply with all applicable laws in carrying out its activities, including Canada's Anti-Spam Legislation (CASL) and applicable privacy laws such as PIPEDA, and obtain all consents required before contacting or referring a Referred Client;",
    "not use Boreal's name, logo, or trademarks except as expressly permitted in writing by Boreal;",
    "not charge any Referred Client a fee for the referral, and not collect or handle any funds on Boreal's behalf; and",
    "conduct itself honestly and in good faith and do nothing that could reasonably harm Boreal's reputation.",
  ]) {
    para(ctx, `-  ${b}`, 8.5, 10);
  }

  heading(ctx, "5. Privacy and Confidentiality");
  para(ctx, "13. Each Party will keep confidential the non-public information of the other Party and of any Referred Client, use it only to perform this Agreement, and protect it with reasonable safeguards. This obligation continues after this Agreement ends.");
  para(ctx, "14. The Referral Partner will handle personal information of Referred Clients in accordance with applicable privacy laws and only for the purpose of making the referral. Once a referral is submitted, Boreal is responsible for the Referred Client relationship and its own communications.");

  heading(ctx, "6. Term and Termination");
  para(ctx, "15. This Agreement begins on the Effective Date and continues until terminated. Either Party may terminate it at any time, with or without cause, on written notice (email is sufficient).");
  para(ctx, "16. Termination does not affect commissions already earned on transactions that funded before termination, subject to the chargeback provisions. Sections concerning confidentiality, taxes, chargebacks, limitation of liability, indemnity, and governing law survive termination.");

  heading(ctx, "7. Representations");
  para(ctx, "17. Each Party represents that it has the authority to enter into this Agreement. The Referral Partner represents that it is not prohibited by law, contract, or any licensing or regulatory requirement from making referrals or receiving commissions under this Agreement.");

  heading(ctx, "8. Limitation of Liability and Indemnity");
  para(ctx, "18. To the maximum extent permitted by law, neither Party is liable to the other for indirect, incidental, special, or consequential damages. Boreal's total liability under this Agreement will not exceed the total commissions paid to the Referral Partner in the twelve (12) months before the event giving rise to the claim.");
  para(ctx, "19. The Referral Partner will indemnify Boreal against claims, losses, and reasonable costs arising from the Referral Partner's breach of this Agreement, its misrepresentations, or its violation of any law, including CASL or privacy laws.");

  heading(ctx, "9. General");
  para(ctx, "20. Governing law. This Agreement is governed by the laws of the Province of Alberta and the federal laws of Canada applicable there, and the Parties attorn to the courts of Alberta.");
  para(ctx, "21. Entire agreement. This Agreement is the entire agreement between the Parties on its subject matter and replaces any prior understanding. It may be amended only in writing signed by both Parties.");
  para(ctx, "22. Assignment. The Referral Partner may not assign this Agreement without Boreal's prior written consent. Boreal may assign it to an affiliate or successor.");
  para(ctx, "23. Severability & electronic signature. If any provision is unenforceable, the rest remains in effect. The Parties agree this Agreement may be signed electronically and in counterparts, each of which is an original.");

  // Signature block always starts on a fresh page so the fields never split.
  newPage(ctx);
  text(ctx, "Acceptance and Signatures", 12, B, NAVY);
  ctx.y += 18;
  para(ctx, "By signing below, the Referral Partner agrees to the terms of this Referral Partner Agreement.", 8.5, 0, GREY);
  ctx.y += 4;
  text(ctx, "REFERRAL PARTNER", 9.5, B, BLACK);
  ctx.y += 18;

  fieldLine(ctx, "Full name", `{{t:t;r:y;o:"${ROLE}";l:"Full name";w:230;h:16;}}`, true, data?.fullName);
  fieldLine(ctx, "Company (if any)", `{{t:t;r:n;o:"${ROLE}";l:"Company";w:230;h:16;}}`, false, data?.company);
  fieldLine(ctx, "Email", `{{t:t;r:y;o:"${ROLE}";l:"Email";w:230;h:16;}}`, true, data?.email);
  fieldLine(ctx, "Phone", `{{t:t;r:y;o:"${ROLE}";l:"Phone";w:230;h:16;}}`, true, data?.phone);
  fieldLine(ctx, "Street address", `{{t:t;r:y;o:"${ROLE}";l:"Street address";w:230;h:16;}}`, true, data?.street);
  fieldLine(ctx, "City / Province / Postal code", `{{t:t;r:y;o:"${ROLE}";l:"City Province Postal";w:230;h:16;}}`, true, data?.cityProvincePostal);
  fieldLine(ctx, "Payout (e-Transfer) email", `{{t:t;r:y;o:"${ROLE}";l:"Payout email";w:230;h:16;}}`, true, data?.payoutEmail);

  ensure(ctx, 60);
  ctx.y += 10;
  const sigW = (CW - 40) / 2;
  ctx.page.drawLine({ start: { x: M, y: PH - ctx.y }, end: { x: M + sigW, y: PH - ctx.y }, thickness: 0.8, color: rgb(0.3, 0.3, 0.3) });
  ctx.page.drawLine({ start: { x: M + sigW + 40, y: PH - ctx.y }, end: { x: M + CW, y: PH - ctx.y }, thickness: 0.8, color: rgb(0.3, 0.3, 0.3) });
  ctx.page.drawText(`{{t:s;r:y;o:"${ROLE}";w:170;h:20;}}`, { x: M + 2, y: PH - ctx.y + 3, size: 6, font: F, color: WHITE });
  // t:t + l:"Date" on purpose - t:d breaks fieldextract (65656) on this account.
  // BF_SERVER_REFERRER_AGREEMENT_BAKE_v1 - bake today's date; only the signature is left.
  if (data) {
    const bakedDate = new Intl.DateTimeFormat("en-US", { year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
    ctx.page.drawText(bakedDate, { x: M + sigW + 42, y: PH - ctx.y + 3, size: 9, font: F, color: BLACK });
  } else {
    ctx.page.drawText(`{{t:t;r:y;o:"${ROLE}";l:"Date";w:90;h:16;}}`, { x: M + sigW + 42, y: PH - ctx.y + 3, size: 6, font: F, color: WHITE });
  }
  ctx.y += 12;
  text(ctx, "Signature", 8, F, GREY);
  ctx.page.drawText("Date", { x: M + sigW + 40, y: PH - ctx.y, size: 8, font: F, color: GREY });
  ctx.y += 30;

  text(ctx, "BOREAL FINANCIAL GROUP", 9.5, B, BLACK);
  ctx.y += 20;
  para(ctx, "Countersigned by Boreal Financial Group upon acceptance.", 8, 0, GREY);
  ctx.y += 10;
  text(ctx, "Boreal Financial Group | 450 Sparling Crt SW, Edmonton, AB T6X 1G9 | info@boreal.financial", 7.5, F, GREY);

  return doc.save();
}
