// BF_SERVER_v867_BROKER_TOOLS_CONTRACTS - contracts from Word templates.
//
// An Admin uploads a .docx with merge fields like {{business.legal_name}} or {{structure.payment}}. On a deal, staff
// pick the template: the fields are filled from the application, the client, the confirmed vendor invoice and the
// saved structure (staff may type over any value), and the server makes the filled .docx and a PDF. Both are filed on
// the application. Sending puts the PDF (with a signature page per signer) into SignNow; the worker (and a Refresh
// button) checks it and files the signed PDF when everyone has signed.
import type { Q } from "./common.js";
import { str } from "./common.js";
import { DocxError, docxBlocks, mergeDocx, renderContractPdf, templateFields, type Signer } from "./docx.js";
import { brand, countSignings } from "./platform.js";

export const MERGE_FIELDS: Record<string, string> = {
  "today": "Today's date",
  "broker.name": "Your brokerage's name",
  "business.legal_name": "Business legal name",
  "business.operating_name": "Business operating name",
  "business.address": "Business address",
  "business.province": "Business province or state",
  "client.full_name": "Client's full name",
  "client.first_name": "Client's first name",
  "client.email": "Client's email",
  "client.phone": "Client's phone",
  "principals.names": "Principals / guarantors",
  "deal.amount": "Amount requested",
  "deal.product": "Product",
  "deal.reference": "File reference",
  "lender.name": "Lender",
  "equipment.description": "Equipment (one line each)",
  "equipment.serial_numbers": "Serial numbers / VINs",
  "equipment.vendor": "Equipment vendor",
  "equipment.invoice_number": "Vendor invoice number",
  "equipment.cost": "Equipment cost (before tax)",
  "equipment.invoice_total": "Invoice total (with tax)",
  "structure.lender": "Chosen structure: lender",
  "structure.term_months": "Chosen structure: term (months)",
  "structure.rate": "Chosen structure: rate",
  "structure.payment": "Chosen structure: payment before tax",
  "structure.payment_with_tax": "Chosen structure: payment with tax",
  "structure.financed": "Chosen structure: amount financed",
  "structure.residual": "Chosen structure: residual",
};

const money = (v: unknown): string => {
  const n = Number(v);
  return v === null || v === undefined || v === "" || !Number.isFinite(n) ? "" : `$${n.toLocaleString("en-CA", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
};
const s = (v: unknown) => { const t = String(v ?? "").trim(); return t; };
const get = (o: any, path: string) => path.split(".").reduce((x: any, k) => (x == null ? undefined : x[k]), o);
const first = (o: any, ...paths: string[]) => { for (const p of paths) { const v = s(get(o, p)); if (v) return v; } return ""; };

/** The merge values for a deal, from what is on it. */
export function mergeValuesFrom(input: {
  app: Record<string, any>; contact: Record<string, any> | null; company: Record<string, any> | null; structure: Record<string, any> | null; lenderName: string | null; today?: string;
}): Record<string, string> {
  const { app, contact, company } = input;
  const md = app.metadata ?? {};
  const inv = (Array.isArray(md.equipment_invoices) ? md.equipment_invoices : []) as any[];
  const equipment = inv.flatMap((i) => (Array.isArray(i?.equipment) ? i.equipment : []));
  const principals: string[] = [];
  for (const p of [md.applicant, ...(Array.isArray(md.owners) ? md.owners : []), ...(Array.isArray(md.principals) ? md.principals : [])]) {
    const n = [s(p?.firstName ?? p?.first_name), s(p?.lastName ?? p?.last_name)].filter(Boolean).join(" ") || s(p?.fullName ?? p?.name);
    if (n && !principals.includes(n)) principals.push(n);
  }
  const clientName = s(contact?.name) || [first(md, "applicant.firstName", "applicant.first_name"), first(md, "applicant.lastName", "applicant.last_name")].filter(Boolean).join(" ");
  const st = input.structure ?? null;
  const address = [first(md, "business.address", "business.street") || s(company?.address_street), first(md, "business.city") || s(company?.city),
    first(md, "business.province", "business.state") || s(company?.province), first(md, "business.postalCode", "business.zip")].filter(Boolean).join(", ");
  return {
    "today": input.today ?? new Date().toISOString().slice(0, 10),
    "broker.name": brand(),
    "business.legal_name": first(md, "business.legalName", "company.legalName") || s(company?.legal_name) || s(company?.name) || s(app.name),
    "business.operating_name": first(md, "business.businessName", "business.operatingName", "business.dbaName") || s(company?.name) || s(app.name),
    "business.address": address,
    "business.province": first(md, "business.province", "business.state") || s(company?.province),
    "client.full_name": clientName,
    "client.first_name": clientName.split(/\s+/)[0] ?? "",
    "client.email": s(contact?.email) || first(md, "applicant.email"),
    "client.phone": s(contact?.phone) || first(md, "applicant.phone"),
    "principals.names": principals.join(", "),
    "deal.amount": money(app.requested_amount),
    "deal.product": s(app.product_category).replace(/_/g, " ").toLowerCase(),
    "deal.reference": String(app.id ?? "").slice(0, 8).toUpperCase(),
    "lender.name": s(st?.lender_name) || s(input.lenderName),
    "equipment.description": equipment.map((e) => s(e?.description) || [e?.year, e?.make, e?.model].filter(Boolean).join(" ")).filter(Boolean).join("; "),
    "equipment.serial_numbers": equipment.map((e) => s(e?.vin) || s(e?.serial_number)).filter(Boolean).join(", "),
    "equipment.vendor": s(inv[inv.length - 1]?.vendor) || s(md.equipment_vendor),
    "equipment.invoice_number": inv.map((i) => s(i?.invoice_number)).filter(Boolean).join(", "),
    "equipment.cost": money(inv.length ? inv.reduce((t, i) => t + Number(i?.subtotal ?? 0), 0) : md.equipment_amount),
    "equipment.invoice_total": inv.length ? money(inv.reduce((t, i) => t + Number(i?.total ?? 0), 0)) : "",
    "structure.lender": s(st?.lender_name),
    "structure.term_months": st?.term_months ? String(st.term_months) : "",
    "structure.rate": st ? (st.rate_kind === "factor" ? `factor ${Number(st.rate).toFixed(2)}` : `${Number(st.rate)}%`) : "",
    "structure.payment": money(st?.payment),
    "structure.payment_with_tax": money(st?.payment_with_tax),
    "structure.financed": money(st?.financed),
    "structure.residual": st && Number(st.residual) > 0 ? money(st.residual) : "",
  };
}

export async function mergeValues(q: Q, app: Record<string, any>): Promise<Record<string, string>> {
  const contact = app.contact_id ? (await q.query(`SELECT name, email, phone FROM contacts WHERE id::text = $1 LIMIT 1`, [String(app.contact_id)])).rows[0] ?? null : null;
  const company = app.company_id ? (await q.query(`SELECT name, legal_name, province, city, address_street FROM companies WHERE id::text = $1 LIMIT 1`, [String(app.company_id)])).rows[0] ?? null : null;
  const st = (await q.query(`SELECT chosen FROM deal_structures WHERE application_id = $1 AND chosen IS NOT NULL ORDER BY created_at DESC LIMIT 1`, [String(app.id)])).rows[0]?.chosen ?? null;
  const lender = app.lender_id ? (await q.query(`SELECT name FROM lenders WHERE id::text = $1 LIMIT 1`, [String(app.lender_id)])).rows[0]?.name ?? null : null;
  return mergeValuesFrom({ app, contact, company, structure: st, lenderName: lender });
}

// ------------------------------------------------------------------------------------------------ templates
export type TemplateRow = { id: string; name: string; description: string | null; file_name: string | null; fields: string[]; unknown_fields: string[]; active: boolean; created_at: string };

export function checkTemplate(docx: Buffer): { ok: true; fields: string[]; unknown: string[] } | { ok: false; error: string } {
  try {
    const fields = templateFields(docx);
    return { ok: true, fields, unknown: fields.filter((f) => !(f in MERGE_FIELDS)) };
  } catch (err) {
    return { ok: false, error: err instanceof DocxError ? err.message : "This is not a Word (.docx) file." };
  }
}

const TPL_COLS = `id::text AS id, name, description, file_name, fields, active, created_at`;
const toTemplate = (r: Record<string, any>): TemplateRow => {
  const fields = Array.isArray(r.fields) ? r.fields.map(String) : [];
  return { id: r.id, name: r.name, description: r.description ?? null, file_name: r.file_name ?? null, fields, unknown_fields: fields.filter((f: string) => !(f in MERGE_FIELDS)), active: r.active !== false, created_at: new Date(r.created_at ?? Date.now()).toISOString() };
};

export async function listTemplates(q: Q): Promise<TemplateRow[]> {
  return (await q.query(`SELECT ${TPL_COLS} FROM contract_templates ORDER BY active DESC, lower(name) LIMIT 200`)).rows.map(toTemplate);
}

export async function addTemplate(q: Q, t: { name: string; description: string | null; file_name: string; docx: Buffer; fields: string[] }, actor: string | null): Promise<TemplateRow> {
  const r = await q.query(
    `INSERT INTO contract_templates (name, description, file_name, docx, fields, created_by) VALUES ($1, $2, $3, $4, $5::jsonb, $6::uuid) RETURNING ${TPL_COLS}`,
    [t.name, t.description, t.file_name, t.docx, JSON.stringify(t.fields), actor],
  );
  return toTemplate(r.rows[0]);
}

// ------------------------------------------------------------------------------------------------ contracts on a deal
export type ContractRow = {
  id: string; application_id: string; template_id: string | null; name: string; status: "generated" | "sent" | "signed" | "cancelled";
  missing: string[]; signers: Signer[]; document_ids: Record<string, string | null>; sent_at: string | null; signed_at: string | null; error: string | null; created_at: string;
};
const C_COLS = `id::text AS id, application_id, template_id::text AS template_id, name, status, missing, signers, document_ids, sent_at, signed_at, error, created_at`;
const iso = (v: unknown) => (v ? new Date(v as string).toISOString() : null);
const toContract = (r: Record<string, any>): ContractRow => ({
  id: r.id, application_id: r.application_id, template_id: r.template_id ?? null, name: r.name, status: r.status, missing: Array.isArray(r.missing) ? r.missing : [],
  signers: Array.isArray(r.signers) ? r.signers : [], document_ids: r.document_ids ?? {}, sent_at: iso(r.sent_at), signed_at: iso(r.signed_at), error: r.error ?? null, created_at: iso(r.created_at)!,
});

export async function listContracts(q: Q, applicationId: string): Promise<ContractRow[]> {
  return (await q.query(`SELECT ${C_COLS} FROM contract_documents WHERE application_id = $1 ORDER BY created_at DESC LIMIT 100`, [applicationId])).rows.map(toContract);
}

export async function getContract(q: Q, applicationId: string, id: string): Promise<(ContractRow & { docx: Buffer | null; pdf: Buffer | null; signed_pdf: Buffer | null; signnow_group_id: string | null; signnow_document_id: string | null }) | null> {
  const r = await q.query(`SELECT ${C_COLS}, docx, pdf, signed_pdf, signnow_group_id, signnow_document_id FROM contract_documents WHERE application_id = $1 AND id = $2::uuid LIMIT 1`, [applicationId, id]);
  const row = r.rows[0];
  return row ? { ...toContract(row), docx: row.docx ?? null, pdf: row.pdf ?? null, signed_pdf: row.signed_pdf ?? null, signnow_group_id: row.signnow_group_id ?? null, signnow_document_id: row.signnow_document_id ?? null } : null;
}

export type FileDoc = (applicationId: string, name: string, bytes: Buffer, mime: string) => Promise<string | null>;

/** Files a generated document with the application's documents (category "other": not read by OCR). A failure is
 *  logged; the contract itself keeps its own copy. */
export const fileOnApplication: FileDoc = async (applicationId, name, bytes, mime) => {
  try {
    const { storeConditionDocument } = await import("../routes/brokerTools.js");
    const out = await storeConditionDocument(applicationId, { buffer: bytes, originalname: name, mimetype: mime, size: bytes.length } as Express.Multer.File, "staff");
    return out.ok ? out.id : null;
  } catch (err) {
    console.error("[broker-tools] contract not filed on the application", { applicationId, name, message: err instanceof Error ? err.message : String(err) });
    return null;
  }
};

export function parseSigners(v: unknown): Signer[] | string {
  const list = Array.isArray(v) ? v : [];
  const out: Signer[] = [];
  for (const [i, x] of list.entries()) {
    const name = str((x as any)?.name, 200), email = str((x as any)?.email, 200);
    if (!name || !email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return "Each signer needs a name and an email address.";
    out.push({ name, email: email.toLowerCase(), role: `Signer ${i + 1}` });
  }
  if (!out.length) return "Add at least one signer.";
  if (out.length > 6) return "Up to six signers.";
  return out;
}

/** Fills the template for the deal and keeps the .docx and PDF (on the contract and in the application's documents). */
export async function generateContract(q: Q, app: Record<string, any>, templateId: string, overrides: Record<string, unknown>, signers: Signer[], actor: string | null, file: FileDoc = fileOnApplication): Promise<ContractRow> {
  const t = (await q.query(`SELECT id, name, docx FROM contract_templates WHERE id = $1::uuid AND active LIMIT 1`, [templateId])).rows[0];
  if (!t) throw new DocxError("Pick an active template.");
  const values = await mergeValues(q, app);
  for (const [k, v] of Object.entries(overrides ?? {})) if (typeof v === "string" && /^[A-Za-z][A-Za-z0-9_.]{0,80}$/.test(k)) values[k] = v.slice(0, 2000);
  const merged = mergeDocx(Buffer.from(t.docx), values);
  const name = `${t.name} - ${values["business.legal_name"] || app.name || "deal"}`.replace(/[^A-Za-z0-9 &.,()_-]+/g, "").slice(0, 150);
  const pdf = Buffer.from(await renderContractPdf(docxBlocks(merged.docx), { title: name, signers, footer: `${name} - ${brand()}` }));
  const docxId = await file(String(app.id), `${name}.docx`, merged.docx, "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
  const pdfId = await file(String(app.id), `${name}.pdf`, pdf, "application/pdf");
  const r = await q.query(
    `INSERT INTO contract_documents (application_id, template_id, name, status, merge_values, missing, docx, pdf, signers, document_ids, created_by)
     VALUES ($1, $2::uuid, $3, 'generated', $4::jsonb, $5::jsonb, $6, $7, $8::jsonb, $9::jsonb, $10::uuid) RETURNING ${C_COLS}`,
    [String(app.id), templateId, name, JSON.stringify(values), JSON.stringify(merged.missing), merged.docx, pdf, JSON.stringify(signers), JSON.stringify({ docx: docxId, pdf: pdfId }), actor],
  );
  return toContract(r.rows[0]);
}

// ------------------------------------------------------------------------------------------------ SignNow
export type SignNowApi = {
  upload: (pdf: Uint8Array, name: string) => Promise<string>;
  group: (documentId: string, name: string) => Promise<string>;
  invite: (groupId: string, signers: Signer[]) => Promise<void>;
  status: (groupId: string) => Promise<{ signed: boolean; summary: string }>;
  download: (documentId: string) => Promise<Buffer | null>;
  configured: () => boolean;
};

/** One SignNow invite for all signers of the group (each signs their own role's fields, in one step). */
async function inviteAll(groupId: string, signers: Signer[]): Promise<void> {
  const key = String(process.env.SIGNNOW_API_KEY ?? "").trim();
  const base = process.env.SIGNNOW_API_BASE_URL || "https://api.signnow.com";
  const payload = { invite: { invite_steps: [{ order: 1, invite_emails: signers.map((x) => ({ email: x.email, full_name: x.name, role_name: x.role })) }] } };
  const res = await fetch(`${base}/documentgroup/${encodeURIComponent(groupId)}/groupinvite`, {
    method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", Accept: "application/json" }, body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`SignNow invite failed (${res.status}): ${(await res.text()).slice(0, 300)}`);
}

export async function defaultSignNow(): Promise<SignNowApi> {
  const sn = await import("../signnow/signnowClient.js");
  return {
    upload: async (pdf, name) => (await sn.uploadDocumentWithFieldExtract(pdf, name)).documentId,
    group: async (documentId, name) => (await sn.createDocumentGroup([documentId], name)).groupId,
    invite: inviteAll,
    status: (groupId) => sn.getDocumentGroupStatus(groupId),
    download: (documentId) => sn.downloadDocument(documentId),
    configured: () => sn.isApiKeyConfigured(),
  };
}

export class ContractSendError extends Error {}

export async function sendContract(q: Q, applicationId: string, id: string, signers: Signer[] | null, api: SignNowApi): Promise<ContractRow> {
  const c = await getContract(q, applicationId, id);
  if (!c || !c.pdf) throw new ContractSendError("Contract not found.");
  if (c.status !== "generated") throw new ContractSendError(`This contract is already ${c.status}.`);
  if (!api.configured()) throw new ContractSendError("E-signing is not set up (SignNow key missing).");
  let pdf = c.pdf;
  let list = c.signers;
  if (signers && JSON.stringify(signers) !== JSON.stringify(c.signers)) {
    // Different signers than when it was made: rebuild the PDF's signature page for them.
    const t = await q.query(`SELECT docx FROM contract_documents WHERE id = $1::uuid`, [id]);
    pdf = Buffer.from(await renderContractPdf(docxBlocks(Buffer.from(t.rows[0].docx)), { title: c.name, signers, footer: `${c.name} - ${brand()}` }));
    list = signers;
  }
  if (!list.length) throw new ContractSendError("Add at least one signer.");
  const documentId = await api.upload(pdf, `${c.name}.pdf`);
  const groupId = await api.group(documentId, c.name);
  await api.invite(groupId, list);
  await countSignings(groupId, list);
  await q.query(
    `UPDATE contract_documents SET status = 'sent', pdf = $3, signers = $4::jsonb, signnow_document_id = $5, signnow_group_id = $6, sent_at = now(), error = NULL, updated_at = now()
      WHERE application_id = $1 AND id = $2::uuid`,
    [applicationId, id, pdf, JSON.stringify(list), documentId, groupId],
  );
  return (await getContract(q, applicationId, id))!;
}

/** Checks a sent contract; when everyone has signed, keeps the signed PDF and files it on the application. */
export async function refreshContract(q: Q, applicationId: string, id: string, api: SignNowApi, file: FileDoc = fileOnApplication): Promise<ContractRow> {
  const c = await getContract(q, applicationId, id);
  if (!c) throw new ContractSendError("Contract not found.");
  if (c.status !== "sent" || !c.signnow_group_id || !c.signnow_document_id) return c;
  const st = await api.status(c.signnow_group_id);
  if (!st.signed) return c;
  const signed = await api.download(c.signnow_document_id);
  const signedId = signed ? await file(applicationId, `${c.name} - signed.pdf`, signed, "application/pdf") : null;
  await q.query(
    `UPDATE contract_documents SET status = 'signed', signed_at = now(), signed_pdf = $3, document_ids = COALESCE(document_ids, '{}'::jsonb) || $4::jsonb, updated_at = now()
      WHERE application_id = $1 AND id = $2::uuid`,
    [applicationId, id, signed, JSON.stringify({ signed: signedId })],
  );
  return (await getContract(q, applicationId, id))!;
}

/** Worker: checks every contract out for signature (oldest first). */
export async function refreshSentContracts(q: Q, api?: SignNowApi): Promise<number> {
  const r = await q.query(`SELECT id::text AS id, application_id FROM contract_documents WHERE status = 'sent' AND sent_at > now() - interval '120 days' ORDER BY updated_at LIMIT 100`);
  if (!r.rows.length) return 0;
  const sn = api ?? (await defaultSignNow());
  if (!sn.configured()) return 0;
  let n = 0;
  for (const row of r.rows) {
    try {
      if ((await refreshContract(q, row.application_id, row.id, sn)).status === "signed") n++;
      else await q.query(`UPDATE contract_documents SET updated_at = now() WHERE id = $1::uuid`, [row.id]);
    } catch (err) {
      console.error("[broker-tools] contract status check failed", { contractId: row.id, message: err instanceof Error ? err.message : String(err) });
    }
  }
  return n;
}
