// BF_SERVER_BLOCK_v201_SIGNNOW_REAL_BUILD_v1
const BASE_URL = process.env.SIGNNOW_API_BASE_URL || "https://api.signnow.com";
export class SignNowError extends Error { constructor(message: string, public readonly status?: number, public readonly body?: unknown) { super(message); this.name = "SignNowError"; } }
export function isApiKeyConfigured(): boolean { return (process.env.SIGNNOW_API_KEY ?? "").trim().length > 0; }
function getApiKey(): string { const k = (process.env.SIGNNOW_API_KEY ?? "").trim(); if (!k) throw new SignNowError("SIGNNOW_API_KEY not set — real SignNow integration requires a bearer token. Set SIGNNOW_STUB_MODE=1 to use the test stub instead."); return k; }
async function signnowFetch(path: string, init: RequestInit): Promise<unknown> {
  const apiKey = getApiKey(); const headers = new Headers(init.headers); headers.set("Authorization", `Bearer ${apiKey}`); if (!headers.has("Accept")) headers.set("Accept", "application/json");
  const res = await fetch(`${BASE_URL}${path}`, { ...init, headers }); const text = await res.text(); let body: unknown; try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  if (!res.ok) throw new SignNowError(`SignNow ${init.method ?? "GET"} ${path} failed: ${res.status} ${(typeof body === "string" ? body : JSON.stringify(body ?? "")).slice(0, 400)}`, res.status, body); return body;
}
export type UploadDocumentResult = { documentId: string };
export async function uploadDocument(pdfBytes: Uint8Array, filename: string): Promise<UploadDocumentResult> {
  const blob = new Blob([new Uint8Array(pdfBytes)], { type: "application/pdf" }); const form = new FormData(); form.append("file", blob, filename);
  const body = (await signnowFetch("/document", { method: "POST", body: form })) as { id?: string }; if (!body || typeof body.id !== "string") throw new SignNowError("SignNow upload returned no document id", undefined, body); return { documentId: body.id };
}
export type SendInviteParams = { documentId: string; signerEmail: string; signerName?: string; fromEmail: string; subject?: string; message?: string; };
export async function sendInvite(p: SendInviteParams): Promise<{ inviteId?: string }> {
  const payload: Record<string, unknown> = { to: [{ email: p.signerEmail, role_id: "", role: "Signer 1", order: 1, ...(p.signerName ? { name: p.signerName } : {}) }], from: p.fromEmail, subject: p.subject ?? "Please sign your loan application", message: p.message ?? "Please review and sign your Boreal Financial loan application." };
  const body = (await signnowFetch(`/document/${encodeURIComponent(p.documentId)}/invite`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) })) as { id?: string }; return { inviteId: body?.id };
}

// BF_SERVER_BLOCK_v712_EMBEDDED_GROUP_SIGNING_v1
// template-copy and document-group are stable SignNow endpoints. The v2
// embedded-invite + link endpoints are isolated here so a payload correction
// after the first live signing is a one-line change, not a rebuild.
// BF_SERVER_REFERRER_TEMPLATE_GEN_v1 - promote an uploaded document to a reusable template.
// SignNow: POST /template with { document_id, document_name } -> { id } (the template id).
export async function createTemplateFromDocument(documentId: string, templateName: string): Promise<{ templateId: string }> {
  const body = (await signnowFetch("/template", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ document_id: documentId, document_name: templateName }) })) as { id?: string };
  if (!body || typeof body.id !== "string") throw new SignNowError("SignNow template creation returned no template id", undefined, body);
  return { templateId: body.id };
}

export async function createDocumentFromTemplate(templateId: string, documentName: string): Promise<{ documentId: string }> {
  const body = (await signnowFetch(`/template/${encodeURIComponent(templateId)}/copy`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ document_name: documentName }) })) as { id?: string };
  if (!body || typeof body.id !== "string") throw new SignNowError("SignNow template copy returned no document id", undefined, body);
  return { documentId: body.id };
}
// BF_SERVER_REFERRER_AGREEMENT_PREFILL_v1 - fill text fields by name so a signer
// doesn't retype data we already have. SignNow: PUT /v2/documents/{id}/prefill-texts
// with { fields: [{ field_name, prefilled_text }] }. Field names come from the
// field-extract tag labels (l:"...").
export async function prefillTextFields(documentId: string, fields: { name: string; value: string | null | undefined }[]): Promise<void> {
  const clean = fields
    .filter((f) => typeof f.value === "string" && f.value.trim().length > 0)
    .map((f) => ({ field_name: f.name, prefilled_text: String(f.value).trim() }));
  if (clean.length === 0) return;
  await signnowFetch(`/v2/documents/${encodeURIComponent(documentId)}/prefill-texts`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ fields: clean }),
  });
}
export async function createDocumentGroup(documentIds: string[], groupName: string): Promise<{ groupId: string }> {
  const body = (await signnowFetch(`/documentgroup`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ document_ids: documentIds, group_name: groupName }) })) as { id?: string };
  if (!body || typeof body.id !== "string") throw new SignNowError("SignNow document group returned no id", undefined, body);
  return { groupId: body.id };
}
export type EmbeddedSigner = { email: string; name?: string; roleName: string };
export async function createEmbeddedGroupInvite(groupId: string, documentIds: string[], signers: EmbeddedSigner[]): Promise<{ inviteId: string }> {
  const signerPayloads = signers.map((signer) => {
    const parts = (signer.name ?? "").trim().split(/\s+/).filter(Boolean);
    const firstName = parts[0] ?? "";
    const lastName = parts.slice(1).join(" ");
    return {
      email: signer.email,
      auth_method: "none",
      ...(firstName ? { first_name: firstName } : {}),
      ...(lastName ? { last_name: lastName } : {}),
      documents: documentIds.map((id) => ({ id, role: signer.roleName, action: "sign" })),
    };
  });
  // BF_SERVER_BLOCK_v_MULTISIGNER_STEPS_v1 — one signer per SEQUENTIAL step. SignNow requires
  // emails unique WITHIN a step but allows the same email across DIFFERENT steps, so putting
  // each signer in their own step lets co-owners (incl. those sharing an inbox) both sign in
  // order and removes the "Email must be unique within one invite step" rejection.
  const payload = { invites: signerPayloads.map((sp, i) => ({ order: i + 1, signers: [sp] })) };
  const body = (await signnowFetch(`/v2/document-groups/${encodeURIComponent(groupId)}/embedded-invites`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) })) as { data?: { id?: string }; id?: string };
  const inviteId = body?.data?.id ?? body?.id;
  if (typeof inviteId !== "string") throw new SignNowError("SignNow embedded group invite returned no id", undefined, body);
  return { inviteId };
}
// BF_SERVER_BLOCK_v203_SIGNNOW_ACCORD_GROUP_v1
export async function uploadDocumentWithFieldExtract(pdfBytes: Uint8Array, filename: string): Promise<UploadDocumentResult> {
  const blob = new Blob([new Uint8Array(pdfBytes)], { type: "application/pdf" });
  const form = new FormData(); form.append("file", blob, filename);
  const body = (await signnowFetch("/document/fieldextract", { method: "POST", body: form })) as { id?: string };
  if (!body || typeof body.id !== "string") throw new SignNowError("SignNow fieldextract returned no document id", undefined, body);
  return { documentId: body.id };
}
export async function sendGroupEmailInvite(groupId: string, signer: EmbeddedSigner & { fromEmail: string; order?: number }): Promise<{ inviteId?: string }> {
  const payload = { invite: { invite_steps: [{ order: signer.order ?? 2, invite_emails: [{ email: signer.email, ...(signer.name ? { full_name: signer.name } : {}), role_name: signer.roleName }] }] } };
  const body = (await signnowFetch(`/documentgroup/${encodeURIComponent(groupId)}/groupinvite`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) })) as { id?: string; data?: { id?: string } };
  return { inviteId: body?.data?.id ?? body?.id };
}
export async function createEmbeddedGroupLink(groupId: string, inviteId: string, email: string): Promise<{ url: string; expiresAt: string | null }> {
  // BF_SERVER_BLOCK_v_SIGN_LINK_EXPIRY_v1 — link_expiration is in MINUTES. The old 45 expired
  // every signing link 45 minutes after it was generated, so a client returning even an hour
  // later hit a dead link. Default to SignNow's embedded-invite cap; override via SIGNNOW_LINK_EXPIRATION_MINUTES
  // (SignNow hard-caps embedded-invite links at 45 min; we clamp to 1..45).
  const expRaw = Number((process.env.SIGNNOW_LINK_EXPIRATION_MINUTES ?? "").trim());
  const link_expiration = Number.isFinite(expRaw) && expRaw > 0 ? Math.min(45, Math.max(1, Math.round(expRaw))) : 45; // BF_SERVER_BLOCK_v_SIGN_LINK_EXPIRY_45CAP_v1 — SignNow HARD-CAPS embedded-invite links at 45 minutes (code 19019003); the CMP regenerates a fresh link on every load, so the practical signing window is unlimited.
  const payload = { email, auth_method: "none", link_expiration };
  const body = (await signnowFetch(`/v2/document-groups/${encodeURIComponent(groupId)}/embedded-invites/${encodeURIComponent(inviteId)}/link`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) })) as { data?: { link?: string }; link?: string };
  const url = body?.data?.link ?? body?.link;
  if (typeof url !== "string") throw new SignNowError("SignNow embedded link returned no url", undefined, body);
  return { url, expiresAt: null };
}
export async function getDocumentGroupStatus(groupId: string): Promise<{ signed: boolean; summary: string }> {
  const body = (await signnowFetch(`/v2/document-groups/${encodeURIComponent(groupId)}`, { method: "GET" })) as any;
  const data = body?.data ?? body ?? {};
  const statuses: string[] = [];
  const docs = Array.isArray(data?.documents) ? data.documents : [];
  for (const d of docs) {
    const fis = Array.isArray(d?.field_invites) ? d.field_invites : [];
    for (const fi of fis) if (typeof fi?.status === "string") statuses.push(String(fi.status).toLowerCase());
  }
  if (statuses.length === 0) {
    const seen: string[] = [];
    const walk = (v: any) => {
      if (!v || typeof v !== "object") return;
      if (typeof v.status === "string" && (v.email || v.role || v.signer_email)) seen.push(String(v.status).toLowerCase());
      for (const k of Object.keys(v)) walk((v as Record<string, unknown>)[k]);
    };
    walk(data);
    statuses.push(...seen);
  }
  // BF_SERVER_BLOCK_v_SIGN_STATUS_APPLICANT_v1 — a signed APPLICANT releases the
  // application to the lender; do NOT deadlock waiting on co-owner signatures. The
  // applicant signs synchronously in the CMP (order:1); co-owners sign later via
  // their own emailed links. Requiring every invite "fulfilled" meant any app with
  // a second owner could never read as signed when the applicant tested solo.
  // Also accept the several completed-status strings SignNow uses, not just
  // "fulfilled". The summary still reports the raw states for diagnosis.
  const COMPLETE = new Set(["fulfilled", "signed", "completed", "complete", "document_signed"]);
  const completed = statuses.filter((s) => COMPLETE.has(s)).length;
  // BF_SERVER_BLOCK_v_SIGN_ALLSIGNERS_v1 — require EVERY invite complete before
  // the group reads as signed. The prior `completed > 0` released the lender
  // package on the FIRST signer (applicant) without waiting for co-owners.
  const signed = statuses.length > 0 && completed === statuses.length;
  return { signed, summary: `invites=${statuses.length} completed=${completed} states=[${[...new Set(statuses)].join(",")}]` };
}
export async function getSignerInviteComplete(groupId: string, signerEmail: string): Promise<boolean> {
  // BF_SERVER_BLOCK_v_SIGNING_SESSION_PERSIGNER_v1 — returns true iff the invite
  // belonging to signerEmail is in a completed state, independent of other signers.
  const want = String(signerEmail || "").trim().toLowerCase();
  if (!want) return false;
  const body = (await signnowFetch(`/v2/document-groups/${encodeURIComponent(groupId)}`, { method: "GET" })) as any;
  const data = body?.data ?? body ?? {};
  const COMPLETE = new Set(["fulfilled", "signed", "completed", "complete", "document_signed"]);
  let found = false;
  const walk = (v: any) => {
    if (!v || typeof v !== "object") return;
    const em = String(v.email ?? v.signer_email ?? "").trim().toLowerCase();
    const st = String(v.status ?? "").trim().toLowerCase();
    if (em && em === want && COMPLETE.has(st)) found = true;
    for (const k of Object.keys(v)) walk((v as Record<string, unknown>)[k]);
  };
  walk(data);
  return found;
}
export async function getDocumentSignedStatus(documentId: string): Promise<{ signed: boolean; summary: string }> {
  const body = (await signnowFetch(`/document/${encodeURIComponent(documentId)}`, { method: "GET" })) as any;
  const data = body?.data ?? body ?? {};
  const fis = Array.isArray(data?.field_invites) ? data.field_invites : [];
  const statuses: string[] = fis.map((fi: any) => String(fi?.status ?? "").toLowerCase()).filter((x: string) => x.length > 0);
  if (statuses.length === 0) {
    const seen: string[] = [];
    const walk = (v: any) => {
      if (!v || typeof v !== "object") return;
      if (typeof v.status === "string" && (v.email || v.role || v.signer_email || v.roles)) seen.push(String(v.status).toLowerCase());
      for (const k of Object.keys(v)) walk((v as Record<string, unknown>)[k]);
    };
    walk(data);
    statuses.push(...seen);
  }
  const fulfilled = statuses.filter((s) => s === "fulfilled").length;
  const signed = statuses.length > 0 && fulfilled === statuses.length;
  return { signed, summary: `doc=${documentId.slice(0, 8)} invites=${statuses.length} fulfilled=${fulfilled} states=[${[...new Set(statuses)].join(",")}]` };
}
export async function downloadDocument(documentId: string): Promise<Buffer | null> {
  const k = (process.env.SIGNNOW_API_KEY ?? "").trim();
  if (!k) return null;
  try {
    const res = await fetch(`${BASE_URL}/document/${encodeURIComponent(documentId)}/download?type=collapsed`, {
      method: "GET",
      headers: { Authorization: `Bearer ${k}`, Accept: "application/pdf" },
    });
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    return buf.length > 0 ? buf : null;
  } catch {
    return null;
  }
}
export async function getAuthenticatedUserId(): Promise<string | null> {
  const body = (await signnowFetch(`/user`, { method: "GET" })) as any;
  const id = body?.id ?? body?.data?.id ?? null;
  return typeof id === "string" && id.trim() ? id.trim() : null;
}
export async function listEventSubscriptions(): Promise<unknown[]> {
  const body = (await signnowFetch(`/api/v2/events`, { method: "GET" })) as any;
  return Array.isArray(body) ? body : Array.isArray(body?.data) ? body.data : [];
}
export async function ensureUserSignedSubscription(
  callbackUrl: string,
  eventName = "user.document.fieldinvite.signed",
): Promise<{ created: boolean; summary: string }> {
  const userId = await getAuthenticatedUserId();
  if (!userId) return { created: false, summary: "no user id from GET /user" };
  let existing: unknown[] = [];
  try { existing = await listEventSubscriptions(); } catch { existing = []; }
  const already = existing.some((it) => {
    const s = JSON.stringify(it ?? "");
    return s.includes(eventName) && s.includes(callbackUrl);
  });
  if (already) return { created: false, summary: `subscription already present (${eventName})` };
  try {
    await signnowFetch(`/api/v2/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        event: eventName,
        entity_id: userId,
        action: "callback",
        attributes: { callback: callbackUrl, use_tls_12: true },
      }),
    });
  } catch (e) {
    // SignNow rejects a duplicate subscription with code 15006045 / "must have
    // different combinations of entityId, eventName, and callbackUrl". That just
    // means the subscription already exists -> treat as success (avoids an error
    // log on every reboot when GET /api/v2/events doesn't dedup cleanly).
    const msg = e instanceof Error ? e.message : String(e);
    if (/different combinations|15006045/i.test(msg)) {
      return { created: false, summary: `subscription already active (${eventName})` };
    }
    throw e;
  }
  return { created: true, summary: `subscription created (${eventName} -> ${callbackUrl})` };
}
