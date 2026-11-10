// BF_SERVER_v936_CLIENT_OFFER_CLEANUP - one place for what a term sheet looks like to a person and what it says:
//   fillOfferFromTermSheet  after a term sheet is uploaded, the reader fills the offer's empty fields (amount, rate,
//                           term, payments, expiry) so the client's offer card is never a row of dashes
//   termSheetForViewing     the file as something a phone can open: a PDF as is, a Word file as a plain HTML page
//   termSheetViewToken      a short-lived link (15 minutes) the client app opens in the phone's browser; a blob URL
//                           handed to the system browser is empty on iPhone
import jwt from "jsonwebtoken";
import { runQuery } from "../db.js";
import { getStorage } from "../lib/storage/index.js";

export const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

function kindOf(buffer: Buffer, filename: string | null): "pdf" | "docx" | "other" {
  if (buffer.subarray(0, 5).toString("latin1") === "%PDF-") return "pdf";
  const zip = buffer.subarray(0, 2).toString("latin1") === "PK";
  if (zip && (/\.docx$/i.test(filename ?? "") || buffer.includes(Buffer.from("word/")))) return "docx";
  return "other";
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Review fix: a Word file can carry javascript: or data: links. Keep only http(s), mailto and tel links, drop any
 *  script/event-handler markup, and (in the route) serve the page with a CSP sandbox so nothing in it can run. */
export function safeDocHtml(html: string): string {
  return html
    .replace(/<\s*(script|iframe|object|embed|style|link|meta|form)\b[\s\S]*?(<\s*\/\s*\1\s*>|\/?>)/gi, "")
    .replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "")
    .replace(/\s(href|src)\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/gi, (_m, attr: string, _v, d?: string, q?: string, b?: string) => {
      const url = String(d ?? q ?? b ?? "").trim();
      const okHref = attr.toLowerCase() === "href" && /^(https?:|mailto:|tel:|#)/i.test(url);
      const okSrc = attr.toLowerCase() === "src" && /^data:image\/(png|jpe?g|gif|webp);base64,/i.test(url);
      return okHref || okSrc ? ` ${attr}="${url.replace(/"/g, "&quot;")}"` : "";
    });
}
export const TERM_SHEET_VIEW_CSP = "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:";

export async function termSheetForViewing(offerId: string): Promise<
  { ok: true; contentType: string; body: Buffer; filename: string } | { ok: false; status: number; error: string }
> {
  const row = await runQuery<{ blob: string | null; filename: string | null; lender: string | null }>(
    `select term_sheet_blob_name as blob, term_sheet_filename as filename, lender_name as lender from offers where id::text = $1 limit 1`,
    [offerId],
  );
  const r = row.rows[0];
  if (!r?.blob) return { ok: false, status: 404, error: "no_term_sheet" };
  const got = await getStorage().get(r.blob).catch(() => null);
  if (!got?.buffer?.length) return { ok: false, status: 404, error: "blob_missing" };
  const kind = kindOf(got.buffer, r.filename);
  const base = (r.filename ?? "term-sheet").replace(/\.[a-z0-9]+$/i, "").replace(/[^\w.\-]/g, "_");
  if (kind === "pdf") return { ok: true, contentType: "application/pdf", body: got.buffer, filename: `${base}.pdf` };
  if (kind === "docx") {
    const mammoth: any = await import("mammoth");
    const convert = mammoth.convertToHtml ?? mammoth.default?.convertToHtml;
    const out = await convert({ buffer: got.buffer });
    const title = `Term sheet${r.lender ? ` - ${esc(r.lender)}` : ""}`;
    const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title><style>body{font-family:-apple-system,Segoe UI,Arial,sans-serif;max-width:820px;margin:0 auto;padding:20px 16px;line-height:1.5;color:#0f172a}
table{border-collapse:collapse;width:100%;margin:12px 0}td,th{border:1px solid #cbd5e1;padding:6px 8px;vertical-align:top}h1{font-size:1.4rem}img{max-width:100%}</style></head>
<body>${safeDocHtml(String(out?.value ?? ""))}</body></html>`;
    return { ok: true, contentType: "text/html; charset=utf-8", body: Buffer.from(html, "utf8"), filename: `${base}.html` };
  }
  return { ok: false, status: 422, error: "unsupported_file" };
}

export function termSheetViewToken(offerId: string): string {
  return jwt.sign({ ts: offerId }, String(process.env.JWT_SECRET), { expiresIn: "15m" });
}
export function offerIdFromViewToken(token: string): string | null {
  try {
    const p = jwt.verify(token, String(process.env.JWT_SECRET), { algorithms: ["HS256"] }) as { ts?: string };
    return typeof p?.ts === "string" ? p.ts : null;
  } catch { return null; }
}

/** Fills the offer's empty fields from its term sheet. Never overwrites what staff typed. Best-effort: logs, never throws. */
export async function fillOfferFromTermSheet(offerId: string): Promise<{ filled: string[] }> {
  try {
    const row = await runQuery<{ blob: string | null; filename: string | null }>(
      `select term_sheet_blob_name as blob, term_sheet_filename as filename from offers where id::text = $1 limit 1`, [offerId]);
    const r = row.rows[0];
    if (!r?.blob) return { filled: [] };
    const got = await getStorage().get(r.blob).catch(() => null);
    if (!got?.buffer?.length) return { filled: [] };
    const kind = kindOf(got.buffer, r.filename);
    const mime = kind === "pdf" ? "application/pdf" : kind === "docx" ? DOCX_MIME : got.contentType || "application/octet-stream";
    const { readOfferDocument } = await import("./offerReader.js");
    const { offer } = await readOfferDocument(got.buffer, mime);
    const rate = offer.rate === null ? null : offer.rate_kind === "factor_rate" ? String(offer.rate) : `${offer.rate}%`;
    const term = offer.term_months ? `${offer.term_months} months` : null;
    const u = await runQuery<{ amount: string | null }>(
      `update offers set
          amount = coalesce(amount, $2::numeric),
          rate_factor = coalesce(nullif(rate_factor, ''), $3),
          term = coalesce(nullif(term, ''), $4),
          payment_frequency = coalesce(nullif(payment_frequency, ''), $5),
          expiry_date = coalesce(expiry_date, $6::date),
          updated_at = now()
        where id::text = $1
        returning amount::text as amount`,
      [offerId, offer.amount, rate, term, offer.payment_frequency, offer.expiry_date],
    );
    const filled = Object.entries({ amount: offer.amount, rate, term, payment_frequency: offer.payment_frequency, expiry_date: offer.expiry_date })
      .filter(([, v]) => v !== null && v !== undefined).map(([k]) => k);
    console.log("[term-sheet] offer filled from the document", { offerId, filled, updated: u.rows.length });
    return { filled };
  } catch (err) {
    console.warn("[term-sheet] offer not filled from the document", { offerId, message: err instanceof Error ? err.message : String(err) });
    return { filled: [] };
  }
}
