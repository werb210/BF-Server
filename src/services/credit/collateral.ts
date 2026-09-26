// BF_SERVER_BLOCK_v536_COLLATERAL_EXTRACTION - structured collateral extraction.
import OpenAI from "openai";
import { pool } from "../../db.js";
import { findActiveDocumentVersion } from "../../modules/applications/applications.repo.js";
import { createOcrStorage } from "../../modules/ocr/ocr.storage.js";
import { readZip } from "../brokerImport/zip.js";

export type CollateralKind = "ar_aging" | "ap_aging" | "equipment" | "real_estate";
export const CATEGORY_KIND: Record<string, CollateralKind> = {
  accounts_receivable_aging: "ar_aging", accounts_payable_aging: "ap_aging",
  equipment_quote: "equipment", equipment_invoice: "equipment", purchase_order: "equipment",
  equipment_list: "equipment", real_estate_schedule: "real_estate",
};

const num = (v: unknown): number | null => {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v !== "string" || !/\d/.test(v)) return null;
  const neg = /^\s*\(.*\)\s*$/.test(v) || /^\s*-/.test(v);
  const n = Number(v.replace(/[^0-9.]/g, ""));
  return Number.isFinite(n) ? (neg ? -n : n) : null;
};
const str = (v: unknown): string | null => { const t = String(v ?? "").trim(); return t ? t.slice(0, 200) : null; };
const date = (v: unknown): string | null => /^\d{4}-\d{2}-\d{2}$/.test(String(v ?? "")) ? String(v) : null;

export type Aging = { as_of: string | null; total: number | null; buckets: { current: number | null; d1_30: number | null; d31_60: number | null; d61_90: number | null; over_90: number | null }; customers: { name: string; total: number; over_90: number | null }[] };
export type Equipment = { vendor: string | null; quote_date: string | null; items: { year: number | null; make: string | null; model: string | null; description: string | null; serial: string | null; hours: number | null; condition: string | null; price: number | null }[]; subtotal: number | null; taxes: number | null; total: number | null };
export type RealEstate = { properties: { address: string; owner: string | null; value: number | null; mortgage_balance: number | null; lender: string | null }[] };

export function normalizeAging(raw: any): Aging {
  const b = raw?.buckets ?? {};
  const customers = (Array.isArray(raw?.customers) ? raw.customers : []).map((c: any) => ({ name: str(c?.name) ?? "", total: num(c?.total) ?? 0, over_90: num(c?.over_90) })).filter((c: { name: string; total: number }) => c.name && c.total !== 0).slice(0, 200);
  return { as_of: date(raw?.as_of), total: num(raw?.total), buckets: { current: num(b.current), d1_30: num(b.d1_30), d31_60: num(b.d31_60), d61_90: num(b.d61_90), over_90: num(b.over_90) }, customers };
}

export function normalizeEquipment(raw: any): Equipment {
  const items = (Array.isArray(raw?.items) ? raw.items : []).map((i: any) => {
    const y = num(i?.year);
    return { year: y && y > 1950 && y < 2100 ? Math.round(y) : null, make: str(i?.make), model: str(i?.model), description: str(i?.description), serial: str(i?.serial), hours: num(i?.hours), condition: str(i?.condition), price: num(i?.price) };
  }).filter((i: any) => i.make || i.model || i.description).slice(0, 100);
  return { vendor: str(raw?.vendor), quote_date: date(raw?.quote_date), items, subtotal: num(raw?.subtotal), taxes: num(raw?.taxes), total: num(raw?.total) };
}

export function normalizeRealEstate(raw: any): RealEstate {
  return { properties: (Array.isArray(raw?.properties) ? raw.properties : []).map((p: any) => ({ address: str(p?.address) ?? "", owner: str(p?.owner), value: num(p?.value), mortgage_balance: num(p?.mortgage_balance), lender: str(p?.lender) })).filter((p: { address: string }) => p.address).slice(0, 50) };
}

export function normalizeFor(kind: CollateralKind, raw: any): Aging | Equipment | RealEstate {
  return kind === "equipment" ? normalizeEquipment(raw) : kind === "real_estate" ? normalizeRealEstate(raw) : normalizeAging(raw);
}

const PROMPTS: Record<CollateralKind, string> = {
  ar_aging: 'This is an accounts receivable aging report. Return ONLY JSON {"as_of":"YYYY-MM-DD","total":n,"buckets":{"current":n,"d1_30":n,"d31_60":n,"d61_90":n,"over_90":n},"customers":[{"name":"","total":n,"over_90":n}]}. Map report columns to the nearest bucket; combine all older-than-90 columns. Include every customer line. Plain dollar numbers.',
  ap_aging: 'This is an accounts payable aging report. Return ONLY JSON {"as_of":"YYYY-MM-DD","total":n,"buckets":{"current":n,"d1_30":n,"d31_60":n,"d61_90":n,"over_90":n},"customers":[{"name":"<vendor>","total":n,"over_90":n}]}. Map report columns to the nearest bucket. Plain dollar numbers.',
  equipment: 'This is an equipment quote, invoice, purchase order or equipment list. Return ONLY JSON {"vendor":"","quote_date":"YYYY-MM-DD","items":[{"year":n,"make":"","model":"","description":"","serial":"","hours":n,"condition":"new|used","price":n}],"subtotal":n,"taxes":n,"total":n}. One item per piece of equipment. Plain dollar numbers.',
  real_estate: 'This is a real estate schedule. Return ONLY JSON {"properties":[{"address":"","owner":"","value":n,"mortgage_balance":n,"lender":""}]}. Plain dollar numbers.',
};

async function extractKind(kind: CollateralKind, text: string): Promise<unknown> {
  if (!process.env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY is not set");
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const response = await openai.chat.completions.create({ model: process.env.CREDIT_LLM_MODEL || process.env.BANKING_LLM_MODEL || "gpt-5.4-mini", response_format: { type: "json_object" }, messages: [{ role: "system", content: `${PROMPTS[kind]} Leave out anything not shown. Never estimate.` }, { role: "user", content: text.slice(0, 80000) }] });
  try { return JSON.parse(response.choices[0]?.message?.content ?? "{}"); } catch { return {}; }
}

const unxml = (s: string) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
export function xlsxToText(buf: Buffer): string {
  const entries = readZip(buf);
  const shared = entries.find((e) => e.name === "sharedStrings.xml")?.data.toString("utf8") ?? "";
  const strings = [...shared.matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => unxml([...m[1]!.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((t) => t[1]).join("")));
  const sheet = entries.filter((e) => /^sheet\d+\.xml$/.test(e.name)).sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))[0];
  if (!sheet) return "";
  const rows: string[] = [];
  for (const row of sheet.data.toString("utf8").matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)) {
    const cells: string[] = [];
    for (const c of row[1]!.matchAll(/<c([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = c[1] ?? ""; const inner = c[2] ?? "";
      const v = /<v>([\s\S]*?)<\/v>/.exec(inner)?.[1] ?? /<t[^>]*>([\s\S]*?)<\/t>/.exec(inner)?.[1] ?? "";
      cells.push(/t="s"/.test(attrs) ? strings[Number(v)] ?? "" : unxml(v));
    }
    if (cells.some((x) => x.trim())) rows.push(cells.join("\t"));
  }
  return rows.join("\n");
}

async function documentText(doc: { id: string; ocr_text: string | null }): Promise<string> {
  if (doc.ocr_text && doc.ocr_text.replace(/\s/g, "").length >= 50) return doc.ocr_text;
  const version = await findActiveDocumentVersion({ documentId: doc.id });
  if (!version) return "";
  const md = (version.metadata ?? {}) as { mimeType?: string; fileName?: string };
  const name = String(md.fileName ?? "").toLowerCase(); const mime = String(md.mimeType ?? "").toLowerCase();
  const isXlsx = mime.includes("spreadsheetml") || name.endsWith(".xlsx");
  const isText = mime.startsWith("text/") || name.endsWith(".csv") || name.endsWith(".txt");
  if (!isXlsx && !isText) return "";
  const buf = await createOcrStorage().fetchBuffer({ content: (version as any).content });
  return isXlsx ? xlsxToText(buf) : buf.toString("utf8");
}

export async function extractApplicationCollateral(applicationId: string): Promise<{ documents: number; stored: number; skipped: string[] }> {
  const docs = await pool.query<{ id: string; name: string | null; category: string; ocr_text: string | null }>(`SELECT d.id::text AS id, COALESCE(d.filename, d.category) AS name, COALESCE(d.category, d.document_type) AS category, o.extracted_text AS ocr_text FROM documents d LEFT JOIN LATERAL (SELECT extracted_text FROM ocr_document_results r WHERE r.document_id = d.id ORDER BY r.created_at DESC LIMIT 1) o ON true WHERE d.application_id::text = $1 AND COALESCE(d.category, d.document_type) = ANY($2::text[]) ORDER BY d.created_at ASC`, [applicationId, Object.keys(CATEGORY_KIND)]);
  const skipped: string[] = []; let stored = 0;
  for (const d of docs.rows) {
    const kind = CATEGORY_KIND[d.category]!; let text = "";
    try { text = await documentText(d); } catch (error) { skipped.push(`${d.name ?? d.id}: could not read (${(error as Error).message})`); continue; }
    if (text.replace(/\s/g, "").length < 50) { skipped.push(`${d.name ?? d.id}: no readable text yet`); continue; }
    const data = normalizeFor(kind, await extractKind(kind, text));
    const result = await pool.query(`INSERT INTO application_collateral (application_id, kind, source_document_id, data, extracted_by, updated_at) VALUES ($1, $2, $3, $4::jsonb, 'ai', now()) ON CONFLICT (application_id, source_document_id) DO UPDATE SET kind = EXCLUDED.kind, data = EXCLUDED.data, updated_at = now() WHERE application_collateral.extracted_by = 'ai'`, [applicationId, kind, d.id, JSON.stringify(data)]);
    stored += result.rowCount ?? 0;
  }
  return { documents: docs.rows.length, stored, skipped };
}

type Row = { id: string; kind: CollateralKind; source_document_id: string | null; data: any; extracted_by: string; updated_at: string };
const pct = (a: number | null, b: number | null) => a !== null && b ? Math.round((a / b) * 1000) / 10 : null;
export function agingSummary(a: Aging) {
  const total = a.total ?? (a.customers.length ? a.customers.reduce((s, c) => s + c.total, 0) : null);
  const over90 = a.buckets.over_90 ?? (a.customers.some((c) => c.over_90 !== null) ? a.customers.reduce((s, c) => s + (c.over_90 ?? 0), 0) : null);
  const sorted = [...a.customers].sort((x, y) => y.total - x.total); const top5 = sorted.slice(0, 5).reduce((s, c) => s + c.total, 0);
  const crossAged = sorted.filter((c) => c.over_90 !== null && c.total > 0 && c.over_90 / c.total > 0.5);
  const eligible = total !== null ? total - (over90 ?? 0) - crossAged.reduce((s, c) => s + (c.total - (c.over_90 ?? 0)), 0) : null;
  return { as_of: a.as_of, total, over_90: over90, over_90_pct: pct(over90, total), top_customer: sorted[0] ? { name: sorted[0].name, total: sorted[0].total, pct: pct(sorted[0].total, total) } : null, top5_pct: sorted.length ? pct(top5, total) : null, cross_aged: crossAged.map((c) => c.name), eligible };
}
export function equipmentSummary(list: Equipment[]) {
  const items = list.flatMap((e) => e.items.map((i) => ({ ...i, vendor: e.vendor })));
  const total = list.reduce((s, e) => s + (e.total ?? e.subtotal ?? e.items.reduce((t, i) => t + (i.price ?? 0), 0)), 0);
  return { items, count: items.length, total: items.length ? total : null, unpriced: items.filter((i) => i.price === null).length };
}
export function realEstateSummary(list: RealEstate[]) {
  const properties = list.flatMap((r) => r.properties); const value = properties.reduce((s, p) => s + (p.value ?? 0), 0); const debt = properties.reduce((s, p) => s + (p.mortgage_balance ?? 0), 0);
  return { properties, value: properties.length ? value : null, mortgages: properties.length ? debt : null, equity: properties.length ? value - debt : null };
}
export async function loadCollateral(applicationId: string) {
  const r = await pool.query<Row>(`SELECT id::text AS id, kind, source_document_id, data, extracted_by, updated_at FROM application_collateral WHERE application_id = $1 ORDER BY updated_at DESC`, [applicationId]);
  const latest = (kind: CollateralKind) => r.rows.filter((x) => x.kind === kind).sort((a, b) => String(b.data?.as_of ?? "").localeCompare(String(a.data?.as_of ?? "")))[0];
  const ar = latest("ar_aging"); const ap = latest("ap_aging");
  return { rows: r.rows, receivables: ar ? { rowId: ar.id, ...agingSummary(normalizeAging(ar.data)) } : null, payables: ap ? { rowId: ap.id, ...agingSummary(normalizeAging(ap.data)) } : null, equipment: equipmentSummary(r.rows.filter((x) => x.kind === "equipment").map((x) => normalizeEquipment(x.data))), realEstate: realEstateSummary(r.rows.filter((x) => x.kind === "real_estate").map((x) => normalizeRealEstate(x.data))) };
}
export async function saveCollateralRow(applicationId: string, rowId: string, data: unknown, userId: string | null): Promise<boolean> {
  const cur = await pool.query<{ kind: CollateralKind }>(`SELECT kind FROM application_collateral WHERE id::text = $1 AND application_id = $2`, [rowId, applicationId]); const kind = cur.rows[0]?.kind;
  if (!kind) return false;
  await pool.query(`UPDATE application_collateral SET data = $3::jsonb, extracted_by = 'staff', edited_by = $4, updated_at = now() WHERE id::text = $1 AND application_id = $2`, [rowId, applicationId, JSON.stringify(normalizeFor(kind, data)), userId]);
  return true;
}
