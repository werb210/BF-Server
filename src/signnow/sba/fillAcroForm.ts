// BF_SERVER_SBA_FORM_FILL_v89
// Fills a fillable PDF by field name. Nothing in the codebase did this before -
// buildApplicationPdf and buildPnwPdf draw text onto blank pages, which is right
// for our own documents and wrong for a government form. SBA lenders expect the
// official 1919/912/413, and 1919 carries statutory certification language that
// must not be paraphrased.
//
// The templates are the official fillable PDFs from sba.gov, stored in blob and
// referenced by env so they can be swapped when SBA revises a form without a
// deploy. Expiration dates matter: 1919 expires 6/30/2027, 413 on 8/31/2027, 912
// on 12/31/2028. A lender will reject a superseded edition.
import { PDFDocument, StandardFonts, rgb, type PDFPage } from "pdf-lib";
import { logInfo } from "../../observability/logger.js";

export type FieldMap = Record<string, string | boolean | undefined | null>;

// BF_SERVER_SBA_SIGN_TAGS_v791 - SignNow only knows who signs a page from a text tag ({{t:s;o:"Owner 1";...}}).
// The SBA forms had none, so SignNow refused every SBA signing: "Role Owner 1 is not found on document".
// Each tag is drawn white at 6 pt (as on the application PDF, which SignNow reads) over the form's own signature or initials box, after flattening.
export type SignTag = { field: string; type: "s" | "i"; role: string };

/**
 * Set every field we have a value for, and leave the rest alone.
 *
 * Deliberately tolerant: a field name that does not exist in the template is
 * logged and skipped rather than thrown. SBA renames fields between editions,
 * and a single renamed field must not stop an entire loan package from being
 * produced - a form with one box empty is recoverable, a crashed dispatch is not.
 */
export async function fillAcroForm(templateBytes: Uint8Array, values: FieldMap, signTags: SignTag[] = []): Promise<Uint8Array> {
  const doc = await PDFDocument.load(templateBytes);
  const form = doc.getForm();
  const tagSpots = locateSignTags(doc, signTags);
  const missing: string[] = [];
  const unmatchedOptions: Array<{ field: string; wanted: string; options: string[] }> = [];
  const tooLong: Array<{ field: string; maxLength: number; value: string }> = [];

  for (const [name, raw] of Object.entries(values)) {
    if (raw === undefined || raw === null || raw === "") continue;
    try {
      if (typeof raw === "boolean") {
        const box = form.getCheckBox(name);
        if (raw) box.check(); else box.uncheck();
      } else {
        // BF_SERVER_SBA_RADIO_FIX_v130 - dispatch on what the field actually is
        // rather than assuming every string target is a text field. A radio
        // group used to throw here and be swallowed as "unknown".
        const field = form.getField(name);
        const kind = field.constructor.name;
        if (kind === "PDFRadioGroup") {
          const group = form.getRadioGroup(name);
          const wanted = String(raw).replace(/^\//, "");
          const options = group.getOptions();
          const match = options.find((o) => o === wanted)
            ?? options.find((o) => o.toLowerCase() === wanted.toLowerCase());
          if (!match) {
            // Selecting a state the widget does not define silently does
            // nothing, so an unmatched option is reported, not guessed at.
            unmatchedOptions.push({ field: name, wanted, options });
          } else {
            group.select(match);
          }
        } else if (kind === "PDFDropdown") {
          form.getDropdown(name).select(String(raw));
        } else {
          form.getTextField(name).setText(String(raw));
        }
      }
    } catch (err) {
      // BF_SERVER_4506C_ADDRESS_v157 - distinguish "no such field" from "the
      // value will not fit", which is a data problem someone can actually act on.
      const msg = String((err as { message?: unknown })?.message ?? err);
      const over = /maxLength=(\d+)/.exec(msg);
      if (over) {
        tooLong.push({ field: name, maxLength: Number(over[1]), value: String(values[name] ?? "").slice(0, 40) });
      } else {
        missing.push(name);
      }
    }
  }

  if (missing.length) {
    logInfo("sba_form_fill_unknown_fields", { count: missing.length, fields: missing.slice(0, 20) });
  }
  if (tooLong.length) {
    logInfo("sba_form_fill_value_too_long", { count: tooLong.length, detail: tooLong.slice(0, 10) });
  }
  if (unmatchedOptions.length) {
    logInfo("sba_form_fill_unmatched_options", { count: unmatchedOptions.length, detail: unmatchedOptions.slice(0, 10) });
  }

  // Flatten so the values are part of the page content. Without this the fields
  // stay editable, and SignNow's own field extraction would fight the AcroForm
  // layer - the signer would see two overlapping sets of inputs.
  // BF_SERVER_SBA_RADIO_FIX_v130 - tests set SBA_NO_FLATTEN so the filled values
  // can be read back off the PDF. Never set in any deployed environment.
  if (!process.env.SBA_NO_FLATTEN) form.flatten();
  if (signTags.length) await drawSignTags(doc, signTags, tagSpots);
  return doc.save();
}

type Spot = { page: PDFPage; x: number; y: number; w: number; h: number };
function locateSignTags(doc: PDFDocument, tags: SignTag[]): Map<string, Spot> {
  const spots = new Map<string, Spot>();
  if (!tags.length) return spots;
  const form = doc.getForm();
  const pages = doc.getPages();
  for (const tag of tags) {
    try {
      const field = form.getFieldMaybe(tag.field);
      const widget = field?.acroField.getWidgets()[0];
      if (!widget) continue;
      const r = widget.getRectangle();
      const pageRef = widget.P();
      let page = pageRef ? pages.find((p) => p.ref === pageRef) : undefined;
      if (!page) {
        page = pages.find((p) => (p.node.Annots()?.asArray() ?? []).some((a) => doc.context.lookup(a) === widget.dict));
      }
      if (page) spots.set(tag.field, { page, x: r.x, y: r.y, w: r.width, h: r.height });
    } catch (err) {
      console.warn("[sba_sign_tags] could not locate field", { field: tag.field.slice(0, 60), message: err instanceof Error ? err.message : String(err) });
    }
  }
  return spots;
}
async function drawSignTags(doc: PDFDocument, tags: SignTag[], spots: Map<string, Spot>): Promise<void> {
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const pages = doc.getPages();
  let placedSignature = false;
  for (const tag of tags) {
    const spot = spots.get(tag.field);
    if (!spot) { logInfo("sba_sign_tag_field_missing", { field: tag.field.slice(0, 60), role: tag.role }); continue; }
    const w = Math.max(40, Math.round(spot.w));
    const h = Math.max(12, Math.round(spot.h));
    // BF_SERVER_SBA_FIELD_PLACEMENT_v793 - SignNow hangs the field DOWN from the tag, so the tag goes at the top of the
    // box; at the bottom the signature landed below the line, over the label (1919, 912, 4506-C).
    spot.page.drawText(signTagText(tag, w, h), { x: spot.x + 1, y: spot.y + spot.h - 6, size: 6, font, color: rgb(1, 1, 1) });
    if (tag.type === "s") placedSignature = true;
  }
  // Never leave a document with no signer: SignNow would refuse the whole signing.
  const sig = tags.find((t) => t.type === "s");
  if (sig && !placedSignature && pages.length) {
    logInfo("sba_sign_tag_fallback", { role: sig.role });
    pages[pages.length - 1]!.drawText(signTagText(sig, 160, 18), { x: 40, y: 40, size: 6, font, color: rgb(1, 1, 1) });
  }
}
export function signTagText(tag: SignTag, w: number, h: number): string {
  return `{{t:${tag.type};r:y;o:"${tag.role}";w:${w};h:${h};}}`;
}

/**
 * Field names differ between SBA editions, so they live in one place per form
 * rather than being scattered through the builders. Populate these from the real
 * templates: `pdftk form.pdf dump_data_fields` or pdf-lib's getFields() lists
 * them. Left empty deliberately - guessing field names would produce a form that
 * silently fills nothing.
 */
export type SbaFieldNames = Record<string, string>;
