// BF_SERVER_v76_BLOCK_1_9 — real package input loader.
// BF_SERVER_v76_BLOCK_1_9_FIX — fields value widened to string|number|boolean|null
// to match buildApplicationPackage.FlatFields and the FlatField producer below.
import type { Pool } from "pg";
import { Buffer } from "node:buffer";
import { getStorage } from "../../lib/storage/index.js";

import { getSignedPnwPdf } from "../../signnow/pnwSigning.js";

export type PackageInputDocs = { category: string; files: { filename: string; content: Buffer }[] };
export type PackageInputs = {
  signedApplicationPdf: Buffer | null;
  creditSummaryPdf: Buffer | null;
  documents: PackageInputDocs[];
  // BF_SERVER_BLOCK_v_ACCORD_PACKAGE_ROOT_v1 — root-level signed supplemental forms.
  additionalSignedDocs: { filename: string; content: Buffer }[];
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

type DateAnchorRec = { role: string; page: number; x: number; y: number };
function fmtSignDate(signedAt: string | null, mode: "iso" | "us"): string {
  if (!signedAt) return "";
  const d = new Date(signedAt);
  if (isNaN(d.getTime())) return "";
  return mode === "us"
    ? d.toLocaleDateString("en-US", { timeZone: "America/Toronto", year: "numeric", month: "2-digit", day: "2-digit" })
    : d.toLocaleDateString("en-CA", { timeZone: "America/Toronto" });
}

async function loadSignedApplicationPdf(ctx: LoadCtx, _fields: FlatField[]): Promise<Buffer | null> {
  const r = await ctx.pool.query<{signnow_document_id:string|null;primary_doc_id:string|null;signed_at:string|null;signed_application_blob_name:string|null;date_anchors:unknown}>(
    `SELECT signnow_document_id,
            (metadata->'signnow_embedded'->'doc_ids'->>0) AS primary_doc_id,
            signnow_app_signed_at AS signed_at,
            (metadata->'signnow_date_anchors') AS date_anchors,
            COALESCE(metadata->>'signed_application_blob_name', NULL) AS signed_application_blob_name
       FROM applications WHERE id::text = $1 LIMIT 1`,
    [ctx.applicationId]
  ).catch(() => ({ rows: [] as Array<{signnow_document_id:string|null;primary_doc_id:string|null;signed_at:string|null;signed_application_blob_name:string|null;date_anchors:unknown}> }));
  const row = r.rows[0];
  const blobName = row?.signed_application_blob_name ?? null;
  if (blobName) { try { const got = await getStorage().get(blobName); if (got?.buffer?.length) return got.buffer; } catch {} }
  // SELF-HEAL: the blob may be missing if finalize never ran (e.g. the SignNow
  // webhook never reached us). Only fetch the REAL signed document on demand when
  // the app is genuinely signed (signnow_app_signed_at set) so we can never ship
  // an unsigned PDF labelled as signed. The download needs a DOCUMENT id, so use
  // doc_ids[0]; signnow_document_id is the GROUP id and would 404 the endpoint.
  if (row?.signed_at) {
    const docId = row.primary_doc_id ?? row.signnow_document_id ?? null;
    if (docId) {
      try {
        const { downloadDocument } = await import("../../signnow/signnowClient.js");
        const pdf = await downloadDocument(docId);
        if (pdf && pdf.length) {
          // v_SIGNNOW_DATE_STAMP: stamp the real signing date at the builder anchors.
          let outPdf: Buffer = Buffer.from(pdf);
          try {
            const anchorsMap = (row?.date_anchors ?? {}) as Record<string, DateAnchorRec[]>;
            const anchors = docId ? anchorsMap[docId] : undefined;
            if (anchors?.length && row?.signed_at) {
              const { stampSignDate } = await import("../../signnow/stampSignDate.js");
              outPdf = Buffer.from(await stampSignDate(outPdf, anchors, fmtSignDate(row.signed_at, "iso")));
            }
          } catch {}
          try {
            const { uploadSignedApplicationPdf } = await import("../../signnow/blobStorage.js");
            const stored = await uploadSignedApplicationPdf(ctx.applicationId, outPdf);
            await ctx.pool.query(`UPDATE applications SET metadata = COALESCE(metadata,'{}'::jsonb) || jsonb_build_object('signed_application_blob_name', $2::text, 'signed_application_blob_url', $3::text), updated_at = now() WHERE id::text = $1`, [ctx.applicationId, stored.blobName, stored.url]).catch(() => {});
          } catch {}
          return outPdf;
        }
      } catch (e) { console.warn("[loadPackageInputs] on-demand signed PDF download failed", e instanceof Error ? e.message : String(e)); }
    }
  }
  // Never fabricate a "signed" application from form data. If the real signed PDF
  // is not available, return null; the package build hard-fails upstream so a
  // lender can never receive an unsigned document labelled as signed.
  return null;
}
async function loadCreditSummaryPdf(ctx: LoadCtx): Promise<Buffer | null> {
  // Credit summary is waived under $500k and must never be a draft. Only include
  // it when the deal is >= $500k AND the summary was actually submitted.
  const g = await ctx.pool.query<{requested_amount:string|number|null;credit_summary_completed_at:string|null}>(`SELECT requested_amount, credit_summary_completed_at FROM applications WHERE id::text = $1 LIMIT 1`, [ctx.applicationId]).catch(()=>({rows:[] as Array<{requested_amount:string|number|null;credit_summary_completed_at:string|null}>}));
  const amt = Number(g.rows[0]?.requested_amount ?? 0);
  const submitted = g.rows[0]?.credit_summary_completed_at != null;
  if ((Number.isFinite(amt) && amt < 500000) || !submitted) return null;
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
// BF_SERVER_BLOCK_v_ACCORD_PACKAGE_INCLUDE_v1 — the embedded signing GROUP can
// contain more than the Boreal application: when an Accord LOC lender is
// finalized, the Accord credit application is doc_ids[1] and the applicant signs
// it in the same group. finalize/loadSignedApplicationPdf only pull doc_ids[0]
// (the Boreal app), so the SIGNED Accord form never reached the lender package.
// Download every signed group doc beyond doc_ids[0] and add it to the package as
// its own document group so it ships in BOTH the email zip and the API payload.
async function loadAdditionalSignedDocs(ctx: LoadCtx): Promise<{ filename: string; content: Buffer }[]> {
  const r = await ctx.pool.query<{ signed_at: string | null; doc_ids: unknown; date_anchors: unknown }>(
    `SELECT signnow_app_signed_at AS signed_at,
            (metadata->'signnow_embedded'->'doc_ids') AS doc_ids,
            (metadata->'signnow_date_anchors') AS date_anchors
       FROM applications WHERE id::text = $1 LIMIT 1`,
    [ctx.applicationId]
  ).catch(() => ({ rows: [] as Array<{ signed_at: string | null; doc_ids: unknown; date_anchors: unknown }> }));
  const row = r.rows[0];
  if (!row?.signed_at) return [];
  const ids = Array.isArray(row.doc_ids) ? (row.doc_ids as unknown[]).map((v) => String(v)) : [];
  // doc_ids[0] is the Boreal application (already the signedApplicationPdf). Only
  // the SUPPLEMENTAL signed forms (Accord today, future co-forms) are pulled here.
  const extra = ids.slice(1).filter((s) => s && s.length > 0);
  if (extra.length === 0) return [];
  // Label as the Accord credit application iff an Accord lender is finalized; the
  // only supplemental form the signing group adds today is Accord's. Generic
  // fallback guarantees nothing signed is dropped if the mix ever changes.
  const acc = await ctx.pool.query<{ n: string }>(
    `SELECT COUNT(*) AS n FROM application_lender_selections s
       JOIN lenders l ON l.id::text = s.lender_id::text
      WHERE s.application_id::text = $1 AND s.finalized_at IS NOT NULL AND l.name ILIKE 'accord%'`,
    [ctx.applicationId]
  ).catch(() => ({ rows: [{ n: "0" }] }));
  const isAccord = Number(acc.rows[0]?.n ?? 0) > 0;
  const files: { filename: string; content: Buffer }[] = [];
  const { downloadDocument } = await import("../../signnow/signnowClient.js");
  for (let i = 0; i < extra.length; i++) {
    const id = extra[i];
    if (!id) continue;
    try {
      const pdf = await downloadDocument(id);
      if (pdf && pdf.length) {
        // v_SIGNNOW_DATE_STAMP: stamp the real signing date (MM/DD/YYYY on the Accord form).
        let content: Buffer = Buffer.from(pdf);
        try {
          const anchorsMap = (row?.date_anchors ?? {}) as Record<string, DateAnchorRec[]>;
          const anchors = anchorsMap[id];
          if (anchors?.length && row?.signed_at) {
            const { stampSignDate } = await import("../../signnow/stampSignDate.js");
            content = Buffer.from(await stampSignDate(content, anchors, fmtSignDate(row.signed_at, "us")));
          }
        } catch {}
        const name = isAccord && extra.length === 1
          ? `accord-credit-application-${ctx.applicationId}.pdf`
          : `signed-form-${i + 1}-${ctx.applicationId}.pdf`;
        files.push({ filename: name, content });
      }
    } catch (e) {
      console.warn("[loadPackageInputs] supplemental signed doc download failed", id, e instanceof Error ? e.message : String(e));
    }
  }
  return files; // root-level; placed alongside signed-application.pdf by the package builder
}

// BF_SERVER_BLOCK_v_FORM_PDFS_v1 — render client-completed CMP forms to PDF and
// attach to the lender package (root, alongside signed-application.pdf).
const FORM_PDF_SPECS: Array<{ docType: string; title: string; file: string }> = [
  { docType: "personal_net_worth", title: "Personal Net Worth Statement", file: "personal-net-worth.pdf" },
  { docType: "net_worth_statement", title: "Personal Net Worth Statement", file: "personal-net-worth.pdf" },
  { docType: "debt_stack", title: "Debt Stack", file: "debt-stack.pdf" },
  { docType: "equipment_list", title: "Equipment Collateral", file: "equipment-collateral.pdf" },
  { docType: "real_estate_collateral_disclosure", title: "Real Estate Collateral", file: "real-estate-collateral.pdf" },
];

function flattenForPdf(value: unknown, prefix = ""): string[] {
  const out: string[] = [];
  const label = (k: string) => (prefix ? `${prefix}.${k}` : k);
  if (Array.isArray(value)) {
    value.forEach((v, i) => { out.push(...flattenForPdf(v, `${prefix}[${i + 1}]`)); });
  } else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (v && typeof v === "object") out.push(...flattenForPdf(v, label(k)));
      else out.push(`${label(k)}: ${v === null || v === undefined ? "" : String(v)}`);
    }
  } else {
    out.push(`${prefix}: ${value === null || value === undefined ? "" : String(value)}`);
  }
  return out;
}

async function loadFormPdfs(ctx: LoadCtx): Promise<{ filename: string; content: Buffer }[]> {
  const r = await ctx.pool.query<{ doc_type: string; data: any; submitted_at: string | null }>(
    `SELECT doc_type, data, submitted_at FROM application_form_responses
      WHERE application_id::text = ($1)::text AND submitted_at IS NOT NULL`,
    [ctx.applicationId],
  ).catch(() => ({ rows: [] as Array<{ doc_type: string; data: any; submitted_at: string | null }> }));
  const bySpec = new Map<string, { title: string; file: string }>();
  for (const s of FORM_PDF_SPECS) bySpec.set(s.docType, { title: s.title, file: s.file });
  const out: { filename: string; content: Buffer }[] = [];
  const seenFiles = new Set<string>();
  for (const row of r.rows) {
    const spec = bySpec.get(String(row.doc_type));
    if (!spec || seenFiles.has(spec.file)) continue;
    seenFiles.add(spec.file);
    try {
      // BF_SERVER_BLOCK_v_PNW_BUILDER_v1 — the Personal Net Worth form renders to
      // the branded Boreal template; every other CMP form keeps the text renderer.
      if (spec.file === "personal-net-worth.pdf") {
        // v_PNW_SIGNING_v1 — include only the individually-signed copy.
        const signed = await getSignedPnwPdf(ctx.applicationId);
        // BF_SERVER_BLOCK_PNW_ORDER_GATE_v1 — NEVER substitute an unsigned PNW.
        // Only the genuinely SignNow-signed copy is shipped; if unsigned, omit it. The
        // lender package worker gate blocks dispatch until required PNW is signed, so
        // by the time the package builds for a gated dispatch this returns the signed copy.
        if (signed) out.push({ filename: spec.file, content: signed });
      } else {
        const header = [spec.title, `Application: ${ctx.applicationId}`,
          row.submitted_at ? `Submitted: ${row.submitted_at}` : "", ""];
        const body = flattenForPdf(row.data ?? {});
        out.push({ filename: spec.file, content: renderTextPdf([...header, ...body]) });
      }
    } catch (e) {
      console.warn("[loadPackageInputs] form pdf render failed", row.doc_type, e instanceof Error ? e.message : String(e));
    }
  }
  return out;
}

export async function loadPackageInputs(ctx: LoadCtx): Promise<PackageInputs> {
  const fields = await loadFields(ctx);
  const [signedApplicationPdf, creditSummaryPdf, documents, additionalSignedDocs, formPdfs] = await Promise.all([loadSignedApplicationPdf(ctx, fields), loadCreditSummaryPdf(ctx), loadAcceptedDocuments(ctx), loadAdditionalSignedDocs(ctx), loadFormPdfs(ctx)]);
  // BF_SERVER_BLOCK_v_FORM_PDFS_v1 — generated CMP form PDFs ride in at package root.
  return { signedApplicationPdf, creditSummaryPdf, documents, additionalSignedDocs: [...additionalSignedDocs, ...formPdfs], fields };
}
