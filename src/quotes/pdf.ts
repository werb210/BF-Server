// BF_SERVER_v872_QUOTES - the branded quote PDF (ported from KS-server #50): Boreal's navy band and name, who it is
// for, each option as a card (lender, amount, term, rate or factor, payment, fees and their sales tax, total repaid,
// cost of borrowing, estimated APR), and the plain-language notes. pdf-lib standard fonts, so every string passes
// through winAnsi.
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage, type RGB } from "pdf-lib";
import { brandName, supportPhone } from "../settingsPack/boreal.js";
import { FREQUENCY_LABEL } from "./calc.js";
import type { OptionRow, QuoteView } from "./service.js";

const PW = 612, PH = 792, M = 48, CW = PW - M * 2;
const INK = rgb(0.06, 0.09, 0.16);
const GREY = rgb(0.29, 0.33, 0.39); // #4B5563 on white: 7.6:1
const LINE = rgb(0.85, 0.87, 0.9);
/** Boreal navy (#0B1F3A); white on it is 16:1. */
const NAVY = rgb(11 / 255, 31 / 255, 58 / 255);
export const LEGAL_NAME = "2630108 Alberta Ltd., trading as Boreal Financial";
export const MAILING_ADDRESS = "450 Sparling Crt SW, Edmonton, AB T6X 1G9";

/** pdf-lib's standard fonts only draw WinAnsi: typographic quotes and dashes become plain ones, anything else is dropped. */
export function winAnsi(s: string): string {
  return String(s ?? "")
    .replace(/[\u2018\u2019\u201B]/g, "'").replace(/[\u201C\u201D\u201F]/g, '"').replace(/[\u2013\u2014\u2212]/g, "-")
    .replace(/\u2026/g, "...").replace(/\u00A0/g, " ")
    .replace(/[^\x20-\x7E\n\u00A1-\u00FF]/g, "");
}

export function money(n: number | null | undefined, currency: string): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "-";
  const s = Math.abs(n).toLocaleString("en-CA", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${n < 0 ? "-" : ""}$${s}${currency === "USD" ? " USD" : ""}`;
}

export function rateText(o: Pick<OptionRow, "rate_kind" | "rate">): string {
  if (o.rate === null) return "-";
  return o.rate_kind === "factor_rate" ? `Factor ${o.rate.toFixed(2)}` : `${o.rate.toFixed(2)}% a year`;
}

export function termText(m: number | null): string {
  if (!m) return "-";
  if (m < 1) return `${Math.round((m * 365) / 12)} days`;
  return Number.isInteger(m) ? `${m} months` : `${m.toFixed(1)} months`;
}

type Ctx = { doc: PDFDocument; page: PDFPage; y: number; F: PDFFont; B: PDFFont };

function t(ctx: Ctx, s: string, x: number, size: number, font: PDFFont, color: RGB = INK): void {
  ctx.page.drawText(winAnsi(s), { x, y: PH - ctx.y, size, font, color });
}

function wrap(s: string, size: number, font: PDFFont, maxW: number): string[] {
  const out: string[] = [];
  for (const para of winAnsi(s).split(/\n+/)) {
    let ln = "";
    for (const w of para.split(" ")) {
      const next = ln ? `${ln} ${w}` : w;
      if (font.widthOfTextAtSize(next, size) > maxW && ln) { out.push(ln); ln = w; } else ln = next;
    }
    if (ln) out.push(ln);
  }
  return out;
}

function newPage(ctx: Ctx): void {
  ctx.page = ctx.doc.addPage([PW, PH]);
  ctx.y = M;
}

function optionCard(ctx: Ctx, o: OptionRow, i: number, currency: string, accent: RGB, accepted: boolean): void {
  const rows: Array<[string, string]> = [
    ["Amount", money(o.amount, currency)],
    ["Term", termText(o.term_months)],
    [o.rate_kind === "factor_rate" ? "Factor rate" : "Interest rate", rateText(o)],
    ["Payment", o.payment_amount === null ? "-" : `${money(o.payment_amount, currency)} ${FREQUENCY_LABEL[o.payment_frequency].toLowerCase()}${o.payment_count ? ` x ${o.payment_count}` : ""}`],
    ...o.fees.map((f): [string, string] => [`Fee: ${f.label}`, `${money(f.amount, currency)}${f.deducted ? " (taken from the funds)" : ""}${f.taxable ? " + tax" : ""}`]),
    ...(o.tax_lines ?? []).map((tl): [string, string] => [`Sales tax on fees: ${tl.label}`, money(tl.amount, currency)]),
    ["Funds you receive", money(o.net_proceeds, currency)],
    ["Total you repay", money(o.total_repayment, currency)],
    ["Total cost of borrowing", money(o.cost_of_borrowing, currency)],
    ...(o.estimated_apr !== null ? [["Estimated APR", `${o.estimated_apr.toFixed(2)}%`] as [string, string]] : []),
  ];
  const noteLines = o.notes ? wrap(o.notes, 9, ctx.F, CW - 24) : [];
  const h = 34 + rows.length * 15 + noteLines.length * 12 + 10;
  if (ctx.y + h > PH - M - 40) newPage(ctx);
  const top = PH - ctx.y;
  ctx.page.drawRectangle({ x: M, y: top - h, width: CW, height: h, borderColor: accepted ? accent : LINE, borderWidth: accepted ? 2 : 1, color: rgb(1, 1, 1) });
  ctx.page.drawRectangle({ x: M, y: top - h, width: 5, height: h, color: accent });
  ctx.y += 20;
  const head = `Option ${i + 1}: ${o.lender_name}${o.product_name ? ` - ${o.product_name}` : ""}`;
  t(ctx, head, M + 16, 12, ctx.B);
  const tags = [o.recommended ? "RECOMMENDED" : "", accepted ? "ACCEPTED" : ""].filter(Boolean).join("  ");
  if (tags) t(ctx, tags, M + CW - 12 - ctx.B.widthOfTextAtSize(tags, 8), 8, ctx.B, INK);
  ctx.y += 16;
  for (const [k, v] of rows) {
    const strong = k === "Total cost of borrowing" || k === "Payment";
    t(ctx, k, M + 16, 9.5, ctx.F, GREY);
    t(ctx, v, M + 200, 9.5, strong ? ctx.B : ctx.F);
    ctx.y += 15;
  }
  for (const ln of noteLines) { t(ctx, ln, M + 16, 9, ctx.F, GREY); ctx.y += 12; }
  ctx.y += 18;
}

export async function renderQuotePdf(q: QuoteView, ctxIn: { businessName: string | null }): Promise<Uint8Array> {
  const primary = NAVY;
  const onPrimary = rgb(1, 1, 1);
  const doc = await PDFDocument.create();
  doc.setTitle(winAnsi(`${q.title} - ${q.quote_number}`));
  doc.setAuthor(winAnsi(LEGAL_NAME));
  const ctx: Ctx = { doc, page: doc.addPage([PW, PH]), y: 0, F: await doc.embedFont(StandardFonts.Helvetica), B: await doc.embedFont(StandardFonts.HelveticaBold) };

  ctx.page.drawRectangle({ x: 0, y: PH - 76, width: PW, height: 76, color: primary });
  ctx.y = 42;
  t(ctx, brandName(), M, 18, ctx.B, onPrimary);
  const qn = `Quote ${q.quote_number}`;
  t(ctx, qn, PW - M - ctx.F.widthOfTextAtSize(winAnsi(qn), 10), 10, ctx.F, onPrimary);
  ctx.y = 108;
  t(ctx, q.title, M, 16, ctx.B);
  ctx.y += 20;
  const meta = [
    ctxIn.businessName ? `Prepared for ${ctxIn.businessName}` : null,
    `Date ${(q.sent_at ?? q.created_at).slice(0, 10)}`,
    q.expires_on ? `Valid until ${q.expires_on}` : null,
  ].filter(Boolean).join("   |   ");
  t(ctx, meta, M, 10, ctx.F, GREY);
  ctx.y += 20;
  if (q.message) {
    for (const ln of wrap(q.message, 10, ctx.F, CW)) { t(ctx, ln, M, 10, ctx.F); ctx.y += 14; }
    ctx.y += 8;
  }
  q.options.forEach((o, i) => optionCard(ctx, o, i, q.currency, primary, q.accepted_option_id === o.id));

  const notes = [
    "Total cost of borrowing is everything you repay plus every fee (and the sales tax on fees), less the amount you borrow. The estimated APR spreads that cost over a year on the funds you actually receive, so you can compare options; it is an estimate, not the lender's disclosure.",
    "These figures summarise the lenders' offers. Each lender's own agreement sets the final terms, and every offer is subject to the lender's final approval.",
    `To accept, open your application in our client app and choose an option${q.expires_on ? ` before ${q.expires_on}` : ""}.`,
  ];
  if (ctx.y > PH - M - 110) newPage(ctx);
  for (const n of notes) {
    for (const ln of wrap(n, 8.5, ctx.F, CW)) { t(ctx, ln, M, 8.5, ctx.F, GREY); ctx.y += 11.5; }
    ctx.y += 4;
  }
  const footer = [LEGAL_NAME, MAILING_ADDRESS, `Questions? Call ${supportPhone()}.`].join("  |  ");
  for (const p of ctx.doc.getPages()) {
    p.drawLine({ start: { x: M, y: 40 }, end: { x: PW - M, y: 40 }, thickness: 0.5, color: LINE });
    p.drawText(winAnsi(footer).slice(0, 140), { x: M, y: 28, size: 7.5, font: ctx.F, color: GREY });
  }
  return doc.save();
}
