// BF_SERVER_v846_FRAUD - the "pre-screened" page in the lender package (check 16). Added only when staff turned it on
// for the application (or the Admin default in Settings says so). A plain one-to-few page PDF built with pdf-lib.
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import type { Q } from "./types.js";
import { allowedChecks, getFraudSettings, listResults } from "./store.js";
import { computeScore, prescreenText } from "./score.js";

export async function renderPrescreenPdf(lines: string[]): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  let page = doc.addPage([612, 792]);
  let y = 750;
  const wrap = (text: string, size: number, f: typeof font): string[] => {
    const words = text.replace(/[^\x20-\x7E]/g, " ").split(" ");
    const out: string[] = [];
    let cur = "";
    for (const w of words) {
      const next = cur ? `${cur} ${w}` : w;
      if (f.widthOfTextAtSize(next, size) > 512 && cur) { out.push(cur); cur = w; } else cur = next;
    }
    out.push(cur);
    return out;
  };
  lines.forEach((line, i) => {
    const isTitle = i === 0;
    const size = isTitle ? 15 : 10.5;
    const f = isTitle || /^[A-Z][^:]*:$/.test(line.trim()) || line.startsWith("Fraud score") ? bold : font;
    for (const part of line ? wrap(line, size, f) : [""]) {
      if (y < 50) { page = doc.addPage([612, 792]); y = 750; }
      page.drawText(part, { x: 50, y, size, font: f, color: rgb(0.07, 0.09, 0.15) });
      y -= size + 5;
    }
  });
  return Buffer.from(await doc.save());
}

/** The pre-screen PDF for the lender package, or null when it should not be included. */
export async function loadPrescreenForPackage(db: Q, applicationId: string, company: string): Promise<{ filename: string; content: Buffer } | null> {
  const allowed = allowedChecks();
  const app = (await db.query(`SELECT COALESCE(business_legal_name, name) AS name, fraud_prescreen_in_package AS include FROM applications WHERE id::text = $1`, [applicationId])).rows[0];
  if (!app) return null;
  const include = app.include ?? (await getFraudSettings(db)).include_prescreen_in_package;
  if (!include) return null;
  const score = computeScore(await listResults(db, applicationId), allowed);
  return { filename: "fraud-prescreen.pdf", content: await renderPrescreenPdf(prescreenText(score, { company, applicationName: app.name, at: new Date() })) };
}
