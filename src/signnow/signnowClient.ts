// BF_SERVER_BLOCK_v201_SIGNNOW_REAL_BUILD_v1
const BASE_URL = process.env.SIGNNOW_API_BASE_URL || "https://api.signnow.com";
export class SignNowError extends Error { constructor(message: string, public readonly status?: number, public readonly body?: unknown) { super(message); this.name = "SignNowError"; } }
export function isApiKeyConfigured(): boolean { return (process.env.SIGNNOW_API_KEY ?? "").trim().length > 0; }
function getApiKey(): string { const k = (process.env.SIGNNOW_API_KEY ?? "").trim(); if (!k) throw new SignNowError("SIGNNOW_API_KEY not set — real SignNow integration requires a bearer token. Set SIGNNOW_STUB_MODE=1 to use the test stub instead."); return k; }
async function signnowFetch(path: string, init: RequestInit): Promise<unknown> {
  const apiKey = getApiKey(); const headers = new Headers(init.headers); headers.set("Authorization", `Bearer ${apiKey}`); if (!headers.has("Accept")) headers.set("Accept", "application/json");
  const res = await fetch(`${BASE_URL}${path}`, { ...init, headers }); const text = await res.text(); let body: unknown; try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  if (!res.ok) throw new SignNowError(`SignNow ${init.method ?? "GET"} ${path} failed: ${res.status}`, res.status, body); return body;
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
