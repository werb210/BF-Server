// BF_SERVER_LENDER_QA_EXPORT_v1
// Renders a finalized lender Q&A set to a PDF: applicant + business name, then
// each question and its FINAL ACCEPTED answer only. No lender name and no
// rejection history -- so the same form can travel to multiple lenders without
// revealing who previously saw the file.
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { pool } from "../../db.js";

const PAGE_W = 612; // US Letter
const PAGE_H = 792;
const MARGIN = 54;
const MAX_W = PAGE_W - MARGIN * 2;
const INK = rgb(0.06, 0.09, 0.16);
const MUTED = rgb(0.42, 0.45, 0.5);

type QaRow = { position: number; prompt: string; answer_text: string | null };

function obj(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
}
function sv(v: unknown): string {
  return v === null || v === undefined ? "" : String(v).trim();
}

async function loadNames(applicationId: string): Promise<{ applicant: string; business: string }> {
  const r = await pool.query<{
    name: string | null;
    metadata: unknown;
    first_name: string | null;
    last_name: string | null;
    contact_name: string | null;
  }>(
    `SELECT a.name, a.metadata, c.first_name, c.last_name, c.name AS contact_name
       FROM applications a
       LEFT JOIN contacts c ON c.id = a.contact_id
      WHERE a.id::text = ($1)::text
      LIMIT 1`,
    [applicationId],
  );
  const row = r.rows[0] ?? ({} as Record<string, unknown>);
  const md = obj((row as { metadata?: unknown }).metadata);
  const biz = obj(md.business);
  const appl = obj(md.applicant);
  const business =
    sv(biz.legalName) || sv(biz.companyName) || sv((row as { name?: unknown }).name) || "";
  const applicant =
    sv(`${sv(appl.firstName)} ${sv(appl.lastName)}`) ||
    sv(`${sv((row as { first_name?: unknown }).first_name)} ${sv((row as { last_name?: unknown }).last_name)}`) ||
    sv((row as { contact_name?: unknown }).contact_name) ||
    "";
  return { applicant, business };
}

function wrap(text: string, font: import("pdf-lib").PDFFont, size: number, maxWidth: number): string[] {
  const out: string[] = [];
  for (const rawLine of String(text ?? "").split(/\r?\n/)) {
    const words = rawLine.split(/\s+/).filter(Boolean);
    if (words.length === 0) {
      out.push("");
      continue;
    }
    let line = "";
    for (const word of words) {
      const candidate = line ? `${line} ${word}` : word;
      if (font.widthOfTextAtSize(candidate, size) <= maxWidth) {
        line = candidate;
      } else {
        if (line) out.push(line);
        // hard-break a single word that is wider than the column
        if (font.widthOfTextAtSize(word, size) > maxWidth) {
          let chunk = "";
          for (const ch of word) {
            if (font.widthOfTextAtSize(chunk + ch, size) > maxWidth) {
              out.push(chunk);
              chunk = ch;
            } else {
              chunk += ch;
            }
          }
          line = chunk;
        } else {
          line = word;
        }
      }
    }
    if (line) out.push(line);
  }
  return out;
}

async function render(applicant: string, business: string, round: number, rows: QaRow[]): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);

  let page = doc.addPage([PAGE_W, PAGE_H]);
  let y = PAGE_H - MARGIN;

  const ensure = (needed: number) => {
    if (y - needed < MARGIN) {
      page = doc.addPage([PAGE_W, PAGE_H]);
      y = PAGE_H - MARGIN;
    }
  };
  const line = (text: string, f: import("pdf-lib").PDFFont, size: number, color = INK, gap = 4) => {
    ensure(size + gap);
    page.drawText(text, { x: MARGIN, y: y - size, size, font: f, color });
    y -= size + gap;
  };
  const paragraph = (text: string, f: import("pdf-lib").PDFFont, size: number, color = INK, gap = 3) => {
    for (const ln of wrap(text, f, size, MAX_W)) line(ln, f, size, color, gap);
  };

  line("Lender Questions & Answers", bold, 18, INK, 10);
  if (applicant) line(`Applicant: ${applicant}`, font, 11, MUTED, 2);
  if (business) line(`Business: ${business}`, font, 11, MUTED, 2);
  line(`Round ${round}`, font, 11, MUTED, 14);

  let n = 1;
  for (const row of rows) {
    ensure(40);
    paragraph(`${n}. ${sv(row.prompt)}`, bold, 12, INK, 3);
    y -= 2;
    paragraph(sv(row.answer_text) || "-", font, 11, INK, 3);
    y -= 12;
    n += 1;
  }

  return Buffer.from(await doc.save());
}

// One PDF for a single finalized set (used by the staff download endpoint).
export async function buildQaExportForSet(setId: string): Promise<{ filename: string; content: Buffer } | null> {
  const setRes = await pool.query<{ application_id: string; round: number; status: string }>(
    `SELECT application_id, round, status FROM qa_sets WHERE id = $1 LIMIT 1`,
    [setId],
  );
  const set = setRes.rows[0];
  if (!set) return null;
  const qs = await pool.query<QaRow>(
    `SELECT position, prompt, answer_text
       FROM qa_questions
      WHERE set_id = $1 AND review_status = 'accepted'
      ORDER BY position ASC`,
    [setId],
  );
  if (!qs.rows.length) return null;
  const names = await loadNames(String(set.application_id));
  const content = await render(names.applicant, names.business, Number(set.round), qs.rows);
  return { filename: `lender-questions-round-${set.round}.pdf`, content };
}

// All finalized sets for an application (used by the lender dispatch package).
export async function buildFinalizedQaExports(
  applicationId: string,
): Promise<{ filename: string; content: Buffer }[]> {
  const sets = await pool.query<{ id: string }>(
    `SELECT id FROM qa_sets WHERE application_id = $1 AND status = 'finalized' ORDER BY round ASC`,
    [applicationId],
  );
  const out: { filename: string; content: Buffer }[] = [];
  for (const s of sets.rows) {
    const pdf = await buildQaExportForSet(String(s.id));
    if (pdf) out.push(pdf);
  }
  return out;
}
