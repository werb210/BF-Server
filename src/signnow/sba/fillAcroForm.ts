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
import { PDFDocument } from "pdf-lib";
import { logInfo } from "../../observability/logger.js";

export type FieldMap = Record<string, string | boolean | undefined | null>;

/**
 * Set every field we have a value for, and leave the rest alone.
 *
 * Deliberately tolerant: a field name that does not exist in the template is
 * logged and skipped rather than thrown. SBA renames fields between editions,
 * and a single renamed field must not stop an entire loan package from being
 * produced - a form with one box empty is recoverable, a crashed dispatch is not.
 */
export async function fillAcroForm(templateBytes: Uint8Array, values: FieldMap): Promise<Uint8Array> {
  const doc = await PDFDocument.load(templateBytes);
  const form = doc.getForm();
  const missing: string[] = [];
  const unmatchedOptions: Array<{ field: string; wanted: string; options: string[] }> = [];

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
    } catch {
      missing.push(name);
    }
  }

  if (missing.length) {
    logInfo("sba_form_fill_unknown_fields", { count: missing.length, fields: missing.slice(0, 20) });
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
  return doc.save();
}

/**
 * Field names differ between SBA editions, so they live in one place per form
 * rather than being scattered through the builders. Populate these from the real
 * templates: `pdftk form.pdf dump_data_fields` or pdf-lib's getFields() lists
 * them. Left empty deliberately - guessing field names would produce a form that
 * silently fills nothing.
 */
export type SbaFieldNames = Record<string, string>;
