// BF_SERVER_v76_BLOCK_1_9 — real package input loader.
// BF_SERVER_v76_BLOCK_1_9_FIX — fields value widened to string|number|boolean|null
// to match buildApplicationPackage.FlatFields and the FlatField producer below.
import type { Pool } from "pg";
import { Buffer } from "node:buffer";
import { getStorage } from "../../lib/storage/index.js";

export type PackageInputDocs = { category: string; files: { filename: string; content: Buffer }[] };
export type PackageInputs = {
  signedApplicationPdf: Buffer | null;
  creditSummaryPdf: Buffer | null;
  documents: PackageInputDocs[];
  fields: Array<{ label: string; value: string | number | boolean | null }>;
};
export type LoadCtx = { pool: Pool; applicationId: string };

function renderTextPdf(lines: string[]): Buffer {
  const pdfEscape = (s: string) => s.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
  const PAGE_HEIGHT_TOP = 770, LINE_HEIGHT = 14, PAGE_BOTTOM = 50;
  type Page = string[]; const pages: Page[] = []; let cur: Page = []; let y = PAGE_HEIGHT_TOP;
  for (const raw of lines) {
    const chunks = raw.length === 0 ? [""] : raw.match(/.{1,95}/g) ?? [""];
    for (const c of chunks) {
      if (y < PAGE_BOTTOM) { pages.push(cur); cur = []; y = PAGE_HEIGHT_TOP; }
      cur.push(c); y -= LINE_HEIGHT;
    }
  }
  if (cur.length > 0) pages.push(cur); if (pages.length === 0) pages.push([""]);
  const objects: string[] = [];
  objects.push("1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj");
  const pageObjIds: number[] = []; for (let i=0;i<pages.length;i++) pageObjIds.push(3+i*2);
  objects.push(`2 0 obj << /Type /Pages /Kids [${pageObjIds.map((id)=>`${id} 0 R`).join(" ")}] /Count ${pages.length} >> endobj`);
  let nextId = 3;
  for (const pageLines of pages) {
    const ops: string[] = ["BT", "/F1 10 Tf", "14 TL", `50 ${PAGE_HEIGHT_TOP} Td`];
    for (let i=0;i<pageLines.length;i++) { if (i>0) ops.push("T*"); ops.push(`(${pdfEscape(pageLines[i] ?? "")}) Tj`); }
    ops.push("ET"); const stream = ops.join("\n"); const pageId = nextId++; const contentId = nextId++;
    objects.push(`${pageId} 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${100} 0 R >> >> /Contents ${contentId} 0 R >> endobj`);
    objects.push(`${contentId} 0 obj << /Length ${stream.length} >>\nstream\n${stream}\nendstream\nendobj`);
  }
  objects.push("100 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj");
  let pdf = "%PDF-1.4\n"; const offsets: Record<number, number> = {};
  for (const obj of objects) { const m = /^(\d+)\s+0\s+obj/.exec(obj); if (m) offsets[Number(m[1])] = Buffer.byteLength(pdf, "latin1"); pdf += obj + "\n"; }
  const maxId = Math.max(...Object.keys(offsets).map(Number)); const xrefOffset = Buffer.byteLength(pdf, "latin1");
  pdf += `xref\n0 ${maxId + 1}\n0000000000 65535 f \n`;
  for (let i=1;i<=maxId;i++) { const off = offsets[i]; pdf += off === undefined ? "0000000000 65535 f \n" : `${off.toString().padStart(10,"0")} 00000 n \n`; }
  pdf += `trailer << /Size ${maxId + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;
  return Buffer.from(pdf, "latin1");
}

type FlatField = { label: string; value: string | number | boolean | null };
function flatten(prefix: string, v: unknown, out: FlatField[]): void {
  if (v === null || v === undefined) { if (prefix) out.push({ label: prefix, value: null }); return; }
  if (Array.isArray(v)) { if (v.length===0) { if(prefix) out.push({label:prefix,value:null}); return;} for (let i=0;i<v.length;i++) flatten(`${prefix}[${i+1}]`, v[i], out); return; }
  if (typeof v === "object") { for (const [k,child] of Object.entries(v)) flatten(prefix ? `${prefix}.${k}` : k, child, out); return; }
  if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") { out.push({ label: prefix || "value", value: v }); return; }
  if (prefix) out.push({ label: prefix, value: String(v) });
}

async function loadSignedApplicationPdf(ctx: LoadCtx, fields: FlatField[]): Promise<Buffer | null> {
  const r = await ctx.pool.query<{signnow_document_id:string|null;signed_application_blob_name:string|null}>(`SELECT signnow_document_id, COALESCE(metadata->>'signed_application_blob_name', NULL) AS signed_application_blob_name FROM applications WHERE id::text = $1 LIMIT 1`, [ctx.applicationId]).catch(() => ({ rows: [] as Array<{signnow_document_id:string|null;signed_application_blob_name:string|null}> }));
  const blobName = r.rows[0]?.signed_application_blob_name ?? null;
  if (blobName) { try { const got = await getStorage().get(blobName); if (got?.buffer?.length) return got.buffer; } catch {} }
  const lines = [`Application ${ctx.applicationId}`, "", "(Signed application PDF unavailable; rendered from form data.)", "", ...fields.map((f)=>`${f.label}: ${f.value == null ? "" : String(f.value)}`)];
  return renderTextPdf(lines);
}
async function loadCreditSummaryPdf(ctx: LoadCtx): Promise<Buffer | null> {
  const r = await ctx.pool.query<{sections:unknown;status:string|null}>(`SELECT sections, status FROM credit_summaries WHERE application_id::text = $1 ORDER BY updated_at DESC LIMIT 1`, [ctx.applicationId]).catch(()=>({rows:[] as Array<{sections:unknown;status:string|null}>}));
  if (!r.rows.length) return null; const row = r.rows[0]!; const sections = (row.sections ?? {}) as Record<string, unknown>;
  const lines = [`Credit Summary — Application ${ctx.applicationId}`]; if (row.status) lines.push(`Status: ${row.status}`); lines.push("");
  const sectionTitles: Array<[string,string]> = [["application_overview","1. Application Overview"],["transaction","2. Transaction"],["business_overview","3. Business Overview"],["financial_overview","4. Financial Overview"],["banking_analysis","5. Banking Analysis"],["recommendation","6. Recommendation"]];
  let count=0; for (const [key,title] of sectionTitles){ const sec=sections[key]; if(sec==null) continue; lines.push(title); const sub: FlatField[]=[]; flatten("",sec,sub); for(const sf of sub){ lines.push(`  ${sf.label}: ${sf.value==null?"":String(sf.value)}`); count++; } lines.push(""); }
  if (!count) lines.push("(Credit summary has no content yet.)");
  return renderTextPdf(lines);
}
async function loadAcceptedDocuments(ctx: LoadCtx): Promise<PackageInputDocs[]> {
  const r = await ctx.pool.query<{category:string|null;document_type:string|null;filename:string|null;storage_path:string|null}>(`SELECT COALESCE(category, document_type, 'Other') AS category, document_type, COALESCE(filename, document_type, id::text) AS filename, storage_path FROM documents WHERE application_id::text = $1 AND status = 'accepted' AND storage_path IS NOT NULL ORDER BY category, filename`, [ctx.applicationId]).catch(()=>({rows:[] as Array<{category:string|null;document_type:string|null;filename:string|null;storage_path:string|null}>}));
  const groups = new Map<string,{filename:string;content:Buffer}[]>(); const storage=getStorage();
  for (const row of r.rows){ const cat=(row.category??"Other").trim()||"Other"; const fn=(row.filename??"document").trim()||"document"; if(!row.storage_path) continue; try{ const got=await storage.get(row.storage_path); if(got?.buffer?.length){ if(!groups.has(cat)) groups.set(cat,[]); groups.get(cat)!.push({filename:fn,content:got.buffer});}}catch{} }
  return Array.from(groups.entries()).map(([category,files])=>({category,files}));
}
async function loadFields(ctx: LoadCtx): Promise<FlatField[]> {
  const r = await ctx.pool.query<{metadata:unknown;name:string|null;requested_amount:string|number|null;product_category:string|null;product_type:string|null}>(`SELECT metadata, name, requested_amount, product_category, product_type FROM applications WHERE id::text = $1 LIMIT 1`, [ctx.applicationId]).catch(()=>({rows:[] as Array<{metadata:unknown;name:string|null;requested_amount:string|number|null;product_category:string|null;product_type:string|null}>}));
  const row = r.rows[0]; if(!row) return []; const out: FlatField[]=[];
  out.push({label:"Application ID", value:ctx.applicationId},{label:"Application Name",value:row.name??null},{label:"Requested Amount",value:row.requested_amount==null?null:Number(row.requested_amount)},{label:"Product Category",value:row.product_category??null},{label:"Product Type",value:row.product_type??null});
  flatten("", row.metadata ?? {}, out); return out;
}
export async function loadPackageInputs(ctx: LoadCtx): Promise<PackageInputs> {
  const fields = await loadFields(ctx);
  const [signedApplicationPdf, creditSummaryPdf, documents] = await Promise.all([loadSignedApplicationPdf(ctx, fields), loadCreditSummaryPdf(ctx), loadAcceptedDocuments(ctx)]);
  return { signedApplicationPdf, creditSummaryPdf, documents, fields };
}
