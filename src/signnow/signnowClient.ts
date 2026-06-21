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
export async function createDocumentFromTemplate(templateId: string, documentName: string): Promise<{ documentId: string }> {
  const body = (await signnowFetch(`/template/${encodeURIComponent(templateId)}/copy`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ document_name: documentName }) })) as { id?: string };
  if (!body || typeof body.id !== "string") throw new SignNowError("SignNow template copy returned no document id", undefined, body);
  return { documentId: body.id };
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
  const payload = { invites: [{ order: 1, signers: signerPayloads }] };
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
  const payload = { email, auth_method: "none", link_expiration: 45 };
  const body = (await signnowFetch(`/v2/document-groups/${encodeURIComponent(groupId)}/embedded-invites/${encodeURIComponent(inviteId)}/link`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) })) as { data?: { link?: string }; link?: string };
  const url = body?.data?.link ?? body?.link;
  if (typeof url !== "string") throw new SignNowError("SignNow embedded link returned no url", undefined, body);
  return { url, expiresAt: null };
}
