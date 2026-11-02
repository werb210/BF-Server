// BF_SERVER_v867_BROKER_TOOLS_INVOICES - vendor invoice reading.
//
// Staff pick an invoice already on the file (or upload one). The AI reads it into a draft: vendor, invoice number,
// date, line items, subtotal, taxes, total, and the equipment with year / make / model / serial number / VIN. The
// draft is checked (lines add up, subtotal + taxes = total, VIN check digit, tax rate against the business's
// province) and shown to staff, who correct it and confirm. Confirming fills the deal's equipment fields
// (applications.metadata.equipment_invoices, and equipment_amount when blank) and, once the file has an Active
// Contract, adds each piece of equipment to the contract's equipment assets (now, or on the next worker tick).
import type { Q } from "./common.js";
import { cents, isoDate, num, str } from "./common.js";
import { applicationProvince, combinedRate, rateOn } from "./salesTax.js";

export type InvoiceLine = { description: string; quantity: number | null; unit_price: number | null; amount: number | null; serial_number: string | null; vin: string | null };
export type InvoiceTax = { label: string; amount: number };
export type EquipmentItem = {
  description: string; year: number | null; make: string | null; model: string | null;
  serial_number: string | null; vin: string | null; condition: "new" | "used" | null; cost: number | null;
};
export type InvoiceData = {
  vendor_name: string | null; vendor_address: string | null; vendor_phone: string | null; vendor_email: string | null;
  vendor_tax_number: string | null; buyer_name: string | null; invoice_number: string | null; invoice_date: string | null;
  currency: string; line_items: InvoiceLine[]; subtotal: number | null; taxes: InvoiceTax[]; total: number | null;
  equipment: EquipmentItem[];
};

const MONTHS: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };
const pad = (n: number) => String(n).padStart(2, "0");

/** A printed invoice date as YYYY-MM-DD: ISO, "Oct 3, 2026", "3 October 2026". Ambiguous 03/04/2026 -> null. */
export function invoiceDate(v: unknown): string | null {
  const t = str(v, 60);
  if (!t) return null;
  const iso = isoDate(t);
  if (iso) return iso;
  const named = /^([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})$/.exec(t) ?? null;
  const named2 = /^(\d{1,2})\s+([A-Za-z]{3,9})\.?,?\s+(\d{4})$/.exec(t) ?? null;
  let y = 0, m = 0, d = 0;
  if (named) { m = MONTHS[named[1]!.toLowerCase().slice(0, named[1]!.toLowerCase().startsWith("sept") ? 4 : 3)] ?? 0; d = Number(named[2]); y = Number(named[3]); }
  else if (named2) { m = MONTHS[named2[2]!.toLowerCase().slice(0, 3)] ?? 0; d = Number(named2[1]); y = Number(named2[3]); }
  else {
    const slash = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(t);
    if (!slash) return null;
    const a = Number(slash[1]), b = Number(slash[2]);
    if (a > 12 && b <= 12) { d = a; m = b; } else if (b > 12 && a <= 12) { m = a; d = b; } else return null;
    y = Number(slash[3]);
  }
  return isoDate(`${y}-${pad(m)}-${pad(d)}`);
}

const VIN_VALUES: Record<string, number> = { A: 1, B: 2, C: 3, D: 4, E: 5, F: 6, G: 7, H: 8, J: 1, K: 2, L: 3, M: 4, N: 5, P: 7, R: 9, S: 2, T: 3, U: 4, V: 5, W: 6, X: 7, Y: 8, Z: 9 };
const VIN_WEIGHTS = [8, 7, 6, 5, 4, 3, 2, 10, 0, 9, 8, 7, 6, 5, 4, 3, 2];

/** 17 characters, no I / O / Q. checkDigit: the North American check digit (position 9) is right. */
export function vinCheck(v: string | null | undefined): { valid: boolean; checkDigit: boolean } {
  const t = String(v ?? "").trim().toUpperCase();
  if (!/^[A-HJ-NPR-Z0-9]{17}$/.test(t)) return { valid: false, checkDigit: false };
  let sum = 0;
  for (let i = 0; i < 17; i++) {
    const c = t[i]!;
    sum += (/\d/.test(c) ? Number(c) : VIN_VALUES[c] ?? 0) * VIN_WEIGHTS[i]!;
  }
  const r = sum % 11;
  return { valid: true, checkDigit: t[8] === (r === 10 ? "X" : String(r)) };
}

const money = (v: unknown): number | null => { const n = num(v); return n === null ? null : cents(n); };
const ident = (v: unknown, max = 60): string | null => { const t = str(v, max); return t ? t.replace(/\s+/g, " ").toUpperCase() : null; };
const arr = (v: unknown): any[] => (Array.isArray(v) ? v : []);

/** Turns whatever the reader returned (or staff typed) into a clean invoice. Unknown keys are ignored. */
export function normaliseInvoice(raw: unknown): InvoiceData {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, any>;
  const vendor = (r.vendor && typeof r.vendor === "object" ? r.vendor : {}) as Record<string, any>;
  const lines: InvoiceLine[] = arr(r.line_items ?? r.lines).map((l: any) => ({
    description: str(l?.description, 500) ?? "",
    quantity: num(l?.quantity), unit_price: money(l?.unit_price), amount: money(l?.amount),
    serial_number: ident(l?.serial_number), vin: ident(l?.vin, 17),
  })).filter((l) => l.description || l.amount !== null).slice(0, 200);
  const taxes: InvoiceTax[] = arr(r.taxes).map((x: any) => ({ label: str(x?.label, 60) ?? "Tax", amount: money(x?.amount) ?? 0 })).filter((x) => x.amount !== 0).slice(0, 10);
  const equipment: EquipmentItem[] = arr(r.equipment).map((e: any) => {
    const year = Math.floor(Number(e?.year));
    return {
      description: str(e?.description, 500) ?? [e?.year, e?.make, e?.model].filter(Boolean).join(" "),
      year: year >= 1950 && year <= 2100 ? year : null,
      make: str(e?.make, 120), model: str(e?.model, 120),
      serial_number: ident(e?.serial_number), vin: ident(e?.vin, 17),
      condition: e?.condition === "new" || e?.condition === "used" ? e.condition : null,
      cost: money(e?.cost),
    };
  }).filter((e) => e.description).slice(0, 100);
  const currency = (str(r.currency, 3) ?? "CAD").toUpperCase();
  return {
    vendor_name: str(vendor.name ?? r.vendor_name, 300), vendor_address: str(vendor.address ?? r.vendor_address, 500),
    vendor_phone: str(vendor.phone ?? r.vendor_phone, 60), vendor_email: str(vendor.email ?? r.vendor_email, 200),
    vendor_tax_number: str(vendor.tax_number ?? r.vendor_tax_number, 60), buyer_name: str(r.buyer_name, 300),
    invoice_number: str(r.invoice_number, 100), invoice_date: invoiceDate(r.invoice_date),
    currency: /^[A-Z]{3}$/.test(currency) ? currency : "CAD",
    line_items: lines, subtotal: money(r.subtotal), taxes, total: money(r.total), equipment,
  };
}

const near = (a: number, b: number) => Math.abs(a - b) <= 0.05;

/** What staff should look at before confirming. expectedTaxRate: the province's combined rate (percent), if known. */
export function checkInvoice(d: InvoiceData, expectedTaxRate: number | null = null): string[] {
  const w: string[] = [];
  if (!d.vendor_name) w.push("The vendor's name was not found.");
  if (!d.invoice_number) w.push("The invoice number was not found.");
  if (!d.invoice_date) w.push("The invoice date was not found (or could not be read as a date).");
  if (d.total === null) w.push("The invoice total was not found.");
  const lineSum = cents(d.line_items.reduce((s, l) => s + (l.amount ?? 0), 0));
  if (d.subtotal !== null && d.line_items.some((l) => l.amount !== null) && !near(lineSum, d.subtotal)) {
    w.push(`The line items add up to ${lineSum.toFixed(2)}, not the subtotal ${d.subtotal.toFixed(2)}.`);
  }
  const taxSum = cents(d.taxes.reduce((s, t) => s + t.amount, 0));
  if (d.subtotal !== null && d.total !== null && !near(cents(d.subtotal + taxSum), d.total)) {
    w.push(`Subtotal ${d.subtotal.toFixed(2)} plus taxes ${taxSum.toFixed(2)} is not the total ${d.total.toFixed(2)}.`);
  }
  if (expectedTaxRate !== null && d.subtotal && d.subtotal > 0 && taxSum > 0) {
    const charged = (taxSum / d.subtotal) * 100;
    if (Math.abs(charged - expectedTaxRate) > 0.5) w.push(`Tax charged is ${charged.toFixed(2)}%; the business's province is ${expectedTaxRate}%. Check where the equipment is delivered.`);
  }
  if (!d.equipment.length) w.push("No equipment was listed. Add the equipment being financed.");
  for (const e of d.equipment) {
    if (e.vin) {
      const v = vinCheck(e.vin);
      if (!v.valid) w.push(`VIN ${e.vin} is not 17 characters of letters and numbers (no I, O or Q).`);
      else if (!v.checkDigit) w.push(`VIN ${e.vin} fails the check digit - one character may be misread.`);
    } else if (!e.serial_number) {
      w.push(`"${e.description.slice(0, 60)}" has no serial number or VIN.`);
    }
  }
  return w;
}

// ------------------------------------------------------------------------------------------------ the AI reader
export type ReaderInput = { text?: string | null; buffer?: Buffer | null; mimeType?: string | null; fileName?: string | null };
export type ReaderOutput = { raw: unknown; model: string };
export type InvoiceReader = (input: ReaderInput) => Promise<ReaderOutput>;

export const INVOICE_PROMPT = [
  "You read equipment vendor invoices (and bills of sale or purchase orders) for an equipment finance broker.",
  "Return ONE JSON object and nothing else, with this shape (omit what is not on the document; never guess):",
  '{"vendor":{"name":"","address":"","phone":"","email":"","tax_number":"GST/HST or QST number"},"buyer_name":"",',
  '"invoice_number":"","invoice_date":"YYYY-MM-DD","currency":"CAD",',
  '"line_items":[{"description":"","quantity":1,"unit_price":0,"amount":0,"serial_number":"","vin":""}],',
  '"subtotal":0,"taxes":[{"label":"GST 5%","amount":0}],"total":0,',
  '"equipment":[{"description":"","year":2024,"make":"","model":"","serial_number":"","vin":"","condition":"new|used","cost":0}]}',
  "Rules: amounts are numbers without currency symbols. List every piece of equipment being sold under equipment (not",
  "freight, fees, warranties or trade-ins). Copy serial numbers and VINs exactly, character by character.",
].join("\n");

export class InvoiceReadError extends Error {
  constructor(message: string, public readonly code: "not_configured" | "unsupported_file" | "unreadable" | "failed") { super(message); }
}

export function parseReaderJson(text: string): unknown {
  const t = String(text ?? "").trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const a = t.indexOf("{"), b = t.lastIndexOf("}");
  if (a === -1 || b <= a) throw new InvoiceReadError("The reader did not return an invoice.", "unreadable");
  try { return JSON.parse(t.slice(a, b + 1)); } catch { throw new InvoiceReadError("The reader's answer could not be read.", "unreadable"); }
}

/** OpenAI (Responses API): the stored OCR text when there is some, otherwise the PDF or image itself. */
export const openAiInvoiceReader: InvoiceReader = async (input) => {
  const key = String(process.env.OPENAI_API_KEY ?? "").trim();
  if (!key) throw new InvoiceReadError("Invoice reading needs the OpenAI key (OPENAI_API_KEY) set on the server.", "not_configured");
  const model = String(process.env.INVOICE_READER_MODEL ?? process.env.OPENAI_OCR_MODEL ?? "gpt-4o-mini").trim();
  const content: Record<string, unknown>[] = [{ type: "input_text", text: INVOICE_PROMPT }];
  const mime = String(input.mimeType ?? "").toLowerCase();
  if (input.text && input.text.trim().length > 40) {
    content.push({ type: "input_text", text: `Invoice text:\n\n${input.text.slice(0, 60_000)}` });
  } else if (input.buffer && mime === "application/pdf") {
    content.push({ type: "input_file", filename: input.fileName ?? "invoice.pdf", file_data: `data:application/pdf;base64,${input.buffer.toString("base64")}` });
  } else if (input.buffer && mime.startsWith("image/")) {
    content.push({ type: "input_image", image_url: `data:${mime};base64,${input.buffer.toString("base64")}` });
  } else {
    throw new InvoiceReadError("Upload the invoice as a PDF or a photo (JPG or PNG).", "unsupported_file");
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 120_000);
  try {
    const r = await fetch("https://api.openai.com/v1/responses", {
      method: "POST", signal: controller.signal,
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model, input: [{ role: "user", content }], text: { format: { type: "json_object" } } }),
    });
    if (!r.ok) throw new InvoiceReadError(`The reader failed (${r.status}).`, "failed");
    const payload = (await r.json()) as Record<string, any>;
    const out = typeof payload.output_text === "string" ? payload.output_text
      : arr(payload.output).flatMap((o: any) => arr(o?.content)).filter((c: any) => c?.type === "output_text").map((c: any) => String(c.text ?? "")).join("\n");
    return { raw: parseReaderJson(out), model };
  } catch (err) {
    if (err instanceof InvoiceReadError) throw err;
    throw new InvoiceReadError("The reader could not be reached. Try again.", "failed");
  } finally {
    clearTimeout(timer);
  }
};

let reader: InvoiceReader = openAiInvoiceReader;
/** Tests swap the reader. */
export function setInvoiceReader(r: InvoiceReader | null): void {
  reader = r ?? openAiInvoiceReader;
}

// ------------------------------------------------------------------------------------------------ storage
export type VendorInvoice = {
  id: string; application_id: string; document_id: string | null; file_name: string | null; status: "draft" | "confirmed" | "discarded";
  source: string; data: InvoiceData; warnings: string[]; model: string | null; read_error: string | null; applied: Record<string, unknown> | null;
  assets_contract_id: string | null; confirmed_at: string | null; created_at: string;
};

const COLS = `id::text AS id, application_id, document_id, file_name, status, source, data, warnings, model, read_error, applied,
  assets_contract_id::text AS assets_contract_id, confirmed_at, created_at`;

export function rowToInvoice(r: Record<string, any>): VendorInvoice {
  return {
    id: String(r.id), application_id: String(r.application_id), document_id: r.document_id ?? null, file_name: r.file_name ?? null,
    status: r.status, source: String(r.source ?? "ai"), data: normaliseInvoice(r.data), warnings: arr(r.warnings).map(String),
    model: r.model ?? null, read_error: r.read_error ?? null, applied: r.applied ?? null, assets_contract_id: r.assets_contract_id ?? null,
    confirmed_at: r.confirmed_at ? new Date(r.confirmed_at).toISOString() : null, created_at: new Date(r.created_at ?? Date.now()).toISOString(),
  };
}

export async function listInvoices(q: Q, applicationId: string): Promise<VendorInvoice[]> {
  const r = await q.query(`SELECT ${COLS} FROM vendor_invoices WHERE application_id = $1 AND status <> 'discarded' ORDER BY created_at DESC LIMIT 100`, [applicationId]);
  return r.rows.map(rowToInvoice);
}

export async function getInvoice(q: Q, applicationId: string, id: string): Promise<VendorInvoice | null> {
  const r = await q.query(`SELECT ${COLS} FROM vendor_invoices WHERE application_id = $1 AND id = $2::uuid LIMIT 1`, [applicationId, id]);
  return r.rows[0] ? rowToInvoice(r.rows[0]) : null;
}

async function expectedRate(q: Q, applicationId: string): Promise<number | null> {
  const p = await applicationProvince(q, applicationId);
  return p ? combinedRate(await rateOn(q, p)) : null;
}

/** The file behind an application document, and its OCR text when the document was already read. */
export async function loadDocumentFile(q: Q, applicationId: string, documentId: string): Promise<{ text: string | null; buffer: Buffer | null; mimeType: string | null; fileName: string | null } | null> {
  const d = await q.query(`SELECT id, filename FROM documents WHERE id::text = $1 AND application_id::text = $2 LIMIT 1`, [documentId, applicationId]);
  if (!d.rows[0]) return null;
  const ocr = await q.query(`SELECT extracted_text FROM ocr_document_results WHERE document_id::text = $1 ORDER BY created_at DESC LIMIT 1`, [documentId]);
  const text = ocr.rows[0]?.extracted_text ? String(ocr.rows[0].extracted_text) : null;
  if (text && text.trim().length > 40) return { text, buffer: null, mimeType: null, fileName: d.rows[0].filename ?? null };
  const { findActiveDocumentVersion } = await import("../modules/applications/applications.repo.js");
  const { createOcrStorage } = await import("../modules/ocr/ocr.storage.js");
  const version = await findActiveDocumentVersion({ documentId });
  if (!version) return { text: null, buffer: null, mimeType: null, fileName: d.rows[0].filename ?? null };
  const meta = (typeof version.metadata === "string" ? JSON.parse(version.metadata) : version.metadata ?? {}) as Record<string, any>;
  const buffer = await createOcrStorage().fetchBuffer({ content: String((version as any).content ?? "") });
  return { text: null, buffer, mimeType: str(meta.mimeType, 100), fileName: str(meta.fileName, 300) ?? d.rows[0].filename ?? null };
}

/** Reads a file into a new draft. A reader failure is kept on the draft (staff can still type it in). */
export async function readInvoice(q: Q, applicationId: string, input: ReaderInput & { documentId?: string | null }, actor: string | null): Promise<VendorInvoice> {
  let data: InvoiceData = normaliseInvoice({});
  let raw: unknown = null, model: string | null = null, error: string | null = null;
  try {
    const out = await reader(input);
    raw = out.raw; model = out.model; data = normaliseInvoice(out.raw);
  } catch (err) {
    if (err instanceof InvoiceReadError && err.code === "not_configured") throw err;
    error = err instanceof Error ? err.message : String(err);
    console.warn("[broker-tools] invoice read failed", { applicationId, message: error });
  }
  const warnings = error ? [] : checkInvoice(data, await expectedRate(q, applicationId));
  const r = await q.query(
    `INSERT INTO vendor_invoices (application_id, document_id, file_name, source, data, warnings, raw, model, read_error, created_by)
     VALUES ($1, $2, $3, 'ai', $4::jsonb, $5::jsonb, $6::jsonb, $7, $8, $9::uuid) RETURNING ${COLS}`,
    [applicationId, input.documentId ?? null, input.fileName ?? null, JSON.stringify(data), JSON.stringify(warnings), raw === null ? null : JSON.stringify(raw), model, error, actor],
  );
  return rowToInvoice(r.rows[0]);
}

/** Staff corrections to a draft (the whole invoice, as the form shows it). */
export async function saveDraft(q: Q, applicationId: string, id: string, body: unknown): Promise<VendorInvoice | null> {
  const data = normaliseInvoice(body);
  const warnings = checkInvoice(data, await expectedRate(q, applicationId));
  const r = await q.query(
    `UPDATE vendor_invoices SET data = $3::jsonb, warnings = $4::jsonb, updated_at = now()
      WHERE application_id = $1 AND id = $2::uuid AND status = 'draft' RETURNING ${COLS}`,
    [applicationId, id, JSON.stringify(data), JSON.stringify(warnings)],
  );
  return r.rows[0] ? rowToInvoice(r.rows[0]) : null;
}

/** What confirming writes on the application: this invoice in metadata.equipment_invoices, and the equipment amount
 *  (the invoice subtotal) when the file has none yet. */
export function metadataPatch(metadata: Record<string, any> | null, inv: { id: string; data: InvoiceData }): Record<string, unknown> {
  const md = metadata ?? {};
  const d = inv.data;
  const entry = {
    invoice_id: inv.id, vendor: d.vendor_name, vendor_tax_number: d.vendor_tax_number, invoice_number: d.invoice_number,
    invoice_date: d.invoice_date, currency: d.currency, subtotal: d.subtotal, taxes: d.taxes, total: d.total, equipment: d.equipment,
  };
  const list = arr(md.equipment_invoices).filter((e: any) => e?.invoice_id !== inv.id);
  const patch: Record<string, unknown> = { equipment_invoices: [...list, entry] };
  const current = num(md.equipment_amount);
  if (!(current && current > 0) && d.subtotal) patch.equipment_amount = d.subtotal;
  if (!str(md.equipment_vendor) && d.vendor_name) patch.equipment_vendor = d.vendor_name;
  return patch;
}

// Active Contracts may not be installed on this server yet: the tables are looked up first (to_regclass).
const CONTRACTS = "active_contracts";
const ASSETS = "active_contract_assets";

/** Adds the invoice's equipment to the file's Active Contract (once). Returns the contract id, or null when the file
 *  has no contract yet (the worker tries again later). Equipment already on the contract (same serial / VIN, or same
 *  description and cost) is not added twice. */
export async function syncInvoiceAssets(q: Q, inv: { id: string; application_id: string; data: InvoiceData }, actor: string | null): Promise<string | null> {
  const t = await q.query(`SELECT to_regclass('public.${ASSETS}') IS NOT NULL AS ok`);
  if (!t.rows[0]?.ok) return null;
  const c = await q.query(`SELECT id::text AS id FROM ${CONTRACTS} WHERE application_id = $1 LIMIT 1`, [inv.application_id]);
  const contractId = c.rows[0]?.id as string | undefined;
  if (!contractId) return null;
  const have = [...(await q.query(`SELECT description, serial_number, cost FROM ${ASSETS} WHERE contract_id = $1::uuid AND removed_at IS NULL`, [contractId])).rows];
  for (const e of inv.data.equipment) {
    const id = e.vin ?? e.serial_number;
    const dup = have.some((h: any) => (id && String(h.serial_number ?? "").toUpperCase() === id)
      || (!id && String(h.description ?? "") === e.description && Number(h.cost ?? NaN) === Number(e.cost ?? NaN)));
    if (dup) continue;
    await q.query(
      `INSERT INTO ${ASSETS} (contract_id, description, year, make, model, serial_number, vendor, cost, created_by) VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8, $9::uuid)`,
      [contractId, e.description, e.year, e.make, e.model, id, inv.data.vendor_name, e.cost, actor],
    );
    have.push({ description: e.description, serial_number: id, cost: e.cost });
  }
  await q.query(`UPDATE vendor_invoices SET assets_contract_id = $2::uuid, updated_at = now() WHERE id = $1::uuid`, [inv.id, contractId]);
  return contractId;
}

export class InvoiceConfirmError extends Error {}

/** Confirms a draft: fills the deal's equipment fields and (when there is a contract) the contract's assets. */
export async function confirmInvoice(q: Q, applicationId: string, id: string, actor: string | null): Promise<VendorInvoice> {
  const inv = await getInvoice(q, applicationId, id);
  if (!inv || inv.status !== "draft") throw new InvoiceConfirmError("Only a draft can be confirmed.");
  if (!inv.data.equipment.length) throw new InvoiceConfirmError("Add the equipment being financed before confirming.");
  const app = await q.query(`SELECT metadata FROM applications WHERE id::text = $1 LIMIT 1`, [applicationId]);
  const patch = metadataPatch(app.rows[0]?.metadata ?? null, inv);
  await q.query(`UPDATE applications SET metadata = COALESCE(metadata, '{}'::jsonb) || $2::jsonb, updated_at = now() WHERE id::text = $1`, [applicationId, JSON.stringify(patch)]);
  await q.query(
    `UPDATE vendor_invoices SET status = 'confirmed', confirmed_by = $3::uuid, confirmed_at = now(), applied = $4::jsonb, updated_at = now()
      WHERE application_id = $1 AND id = $2::uuid`,
    [applicationId, id, actor, JSON.stringify({ metadata_keys: Object.keys(patch) })],
  );
  await syncInvoiceAssets(q, inv, actor);
  return (await getInvoice(q, applicationId, id))!;
}

/** Worker: confirmed invoices whose file has since become an Active Contract get their equipment added. */
export async function syncPendingInvoiceAssets(q: Q): Promise<number> {
  const r = await q.query(`SELECT ${COLS} FROM vendor_invoices WHERE status = 'confirmed' AND assets_contract_id IS NULL ORDER BY confirmed_at LIMIT 200`);
  let n = 0;
  for (const row of r.rows) {
    try {
      if (await syncInvoiceAssets(q, rowToInvoice(row), null)) n++;
    } catch (err) {
      console.error("[broker-tools] invoice assets sync failed", { invoiceId: row.id, message: err instanceof Error ? err.message : String(err) });
    }
  }
  return n;
}
