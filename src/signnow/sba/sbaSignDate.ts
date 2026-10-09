// BF_SERVER_SBA_FIELD_PLACEMENT_v793
// The signed SBA forms came back with every Date box empty: SignNow fills only the signature and initials it
// was told about. After signing, the date is written into each form's own Date box, located from the blank
// template (the signed copy is flattened, so it has no fields left to look up).
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { dbQuery } from "../../db.js";
import { loadSbaTemplate, type SbaFormKey } from "./templates.js";
import { SBA_1919_FIELDS, SBA_912_FIELDS, SBA_413_FIELDS, SBA_4506C_FIELDS } from "./fieldMaps.js";

const DATE_FIELDS: Array<{ match: RegExp; key: SbaFormKey; field: string }> = [
  { match: /sba-1919/, key: "form_1919", field: SBA_1919_FIELDS.sigDate },
  { match: /sba-912/, key: "form_912", field: SBA_912_FIELDS.date },
  { match: /sba-413/, key: "form_413", field: SBA_413_FIELDS.date },
  { match: /4506c/, key: "form_4506c", field: SBA_4506C_FIELDS.signatureDate },
];

/** MM/DD/YYYY in Alberta time (UTC-6 all year), the format the SBA and IRS forms use. */
export function formatSbaDate(d: Date): string {
  const p = new Intl.DateTimeFormat("en-US", { timeZone: "America/Regina", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(d);
  const v = (t: string) => p.find((x) => x.type === t)?.value ?? "";
  return `${v("month")}/${v("day")}/${v("year")}`;
}

/** The day everyone finished signing; today if the application is not stamped yet. */
export async function sbaSignDateFor(applicationId: string): Promise<string> {
  const r = await dbQuery<{ signed_at: string | null }>(
    `SELECT signnow_app_signed_at AS signed_at FROM applications WHERE id::text = ($1)::text LIMIT 1`,
    [applicationId],
  ).catch((err: any) => { console.warn("[sba_sign_date] lookup failed", { applicationId, message: err?.message }); return { rows: [] as Array<{ signed_at: string | null }> }; });
  const at = r.rows[0]?.signed_at;
  return formatSbaDate(at ? new Date(at) : new Date());
}

const templateCache = new Map<SbaFormKey, Uint8Array | null>();
async function template(key: SbaFormKey): Promise<Uint8Array | null> {
  if (!templateCache.has(key)) templateCache.set(key, await loadSbaTemplate(key).catch(() => null));
  return templateCache.get(key) ?? null;
}

export async function dateBoxFor(templateBytes: Uint8Array, field: string): Promise<{ page: number; x: number; y: number; w: number; h: number } | null> {
  const doc = await PDFDocument.load(templateBytes);
  const widget = doc.getForm().getFieldMaybe(field)?.acroField.getWidgets()[0];
  if (!widget) return null;
  const r = widget.getRectangle();
  const pages = doc.getPages();
  const ref = widget.P();
  let page = ref ? pages.findIndex((p) => p.ref === ref) : -1;
  if (page < 0) page = pages.findIndex((p) => (p.node.Annots()?.asArray() ?? []).some((a) => doc.context.lookup(a) === widget.dict));
  return page < 0 ? null : { page, x: r.x, y: r.y, w: r.width, h: r.height };
}

/** Writes the date into the form's Date box; returns the PDF unchanged when the form or box is unknown. */
export async function stampSbaSignDate(name: string, pdf: Buffer, date: string, loadTemplate: (k: SbaFormKey) => Promise<Uint8Array | null> = template): Promise<Buffer> {
  const spec = DATE_FIELDS.find((d) => d.match.test(name));
  if (!spec || !date) return pdf;
  try {
    const tpl = await loadTemplate(spec.key);
    if (!tpl) return pdf;
    const box = await dateBoxFor(tpl, spec.field);
    if (!box) { console.warn("[sba_sign_date] date box not found", { form: spec.key }); return pdf; }
    const doc = await PDFDocument.load(pdf);
    const page = doc.getPages()[box.page];
    if (!page) return pdf;
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const size = Math.max(7, Math.min(10, box.h - 3));
    page.drawText(date, { x: box.x + 2, y: box.y + Math.max(1, (box.h - size) / 2), size, font, color: rgb(0, 0, 0) });
    return Buffer.from(await doc.save());
  } catch (err) {
    console.warn("[sba_sign_date] could not stamp the date", { form: spec.key, message: err instanceof Error ? err.message : String(err) });
    return pdf;
  }
}
