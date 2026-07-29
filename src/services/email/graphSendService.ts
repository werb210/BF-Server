export type GraphAttachment = { filename: string; contentType: string; content: Buffer };
export type GraphSendInput = { to: string | string[]; cc?: string | string[]; bcc?: string | string[]; subject: string; bodyText: string; bodyHtml?: string; attachments?: GraphAttachment[]; sendAs?: string; signatureHtml?: string };
export type GraphSendResult = { ok: true; messageId: string | null } | { ok: false; error: string; status?: number };

// BF_SERVER_GRAPH_LARGE_ATTACHMENTS_v1
const SEND_MAIL_LIMIT = 4 * 1024 * 1024;
const SIMPLE_ATTACHMENT_LIMIT = 3 * 1024 * 1024;
const MAX_ATTACHMENT_SIZE = 150 * 1024 * 1024;
const UPLOAD_CHUNK_SIZE = 5 * 1024 * 1024; // 16 × Graph's required 320 KiB block size.

let cachedToken: { token: string; expiresAt: number } | null = null;

function envOrEmpty(key: string): string { return (process.env[key] ?? "").trim(); }
function asArray(value: string | string[] | undefined): string[] { return value ? (Array.isArray(value) ? value : [value]) : []; }
function isConfigured(): { ok: true } | { ok: false; reason: string } {
  const missing = ["MS_GRAPH_TENANT_ID", "MS_GRAPH_CLIENT_ID", "MS_GRAPH_CLIENT_SECRET", "MS_GRAPH_SEND_AS"].filter((key) => !envOrEmpty(key));
  return missing.length ? { ok: false, reason: `Missing env: ${missing.join(", ")}` } : { ok: true };
}

export function logGraphConfigStatus(): void {
  const config = isConfigured();
  if (config.ok) console.log(`[graph] configured (send-as=${envOrEmpty("MS_GRAPH_SEND_AS")})`);
  else console.warn(`[graph] NOT configured — ${config.reason}. Email sends will fail.`);
}

async function getAccessToken(): Promise<string> {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) return cachedToken.token;
  const url = `https://login.microsoftonline.com/${encodeURIComponent(envOrEmpty("MS_GRAPH_TENANT_ID"))}/oauth2/v2.0/token`;
  const body = new URLSearchParams({ client_id: envOrEmpty("MS_GRAPH_CLIENT_ID"), client_secret: envOrEmpty("MS_GRAPH_CLIENT_SECRET"), grant_type: "client_credentials", scope: "https://graph.microsoft.com/.default" });
  const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body });
  if (!response.ok) throw new Error(`graph_token_failed status=${response.status} body=${(await response.text().catch(() => "")).slice(0, 300)}`);
  const json = await response.json() as { access_token?: string; expires_in?: number };
  if (!json.access_token) throw new Error("graph_token_empty");
  cachedToken = { token: json.access_token, expiresAt: Date.now() + Number(json.expires_in ?? 3600) * 1000 };
  return cachedToken.token;
}

function graphMessage(input: GraphSendInput, includeAttachments: boolean) {
  const signature = (input.signatureHtml ?? "").trim();
  const base = input.bodyHtml ?? (signature ? String(input.bodyText ?? "").replace(/\n/g, "<br/>") : input.bodyText);
  const attachments = input.attachments ?? [];
  return {
    subject: input.subject,
    body: { contentType: input.bodyHtml || signature ? "HTML" : "Text", content: signature ? `${base}<br/><br/>${signature}` : base },
    toRecipients: asArray(input.to).map((address) => ({ emailAddress: { address } })),
    ccRecipients: asArray(input.cc).map((address) => ({ emailAddress: { address } })),
    bccRecipients: asArray(input.bcc).map((address) => ({ emailAddress: { address } })),
    ...(includeAttachments ? { attachments: attachments.map(fileAttachment) } : {}),
  };
}

function fileAttachment(attachment: GraphAttachment) {
  return { "@odata.type": "#microsoft.graph.fileAttachment", name: attachment.filename, contentType: attachment.contentType, contentBytes: attachment.content.toString("base64") };
}

async function responseError(response: Response, prefix: string): Promise<GraphSendResult> {
  const text = await response.text().catch(() => "");
  return { ok: false, status: response.status, error: `${prefix} status=${response.status} body=${text.slice(0, 300)}` };
}

export async function sendViaGraph(input: GraphSendInput): Promise<GraphSendResult> {
  const config = isConfigured();
  if (!config.ok) return { ok: false, error: config.reason };
  const sendAs = (input.sendAs ?? envOrEmpty("MS_GRAPH_SEND_AS")).trim();
  if (!sendAs) return { ok: false, error: "send_as_missing" };
  const attachments = input.attachments ?? [];
  const tooLarge = attachments.find((attachment) => attachment.content.length > MAX_ATTACHMENT_SIZE);
  if (tooLarge) return { ok: false, error: `graph_attachment_too_large: ${tooLarge.filename} exceeds the Microsoft Graph 150 MB attachment limit.` };

  let token: string;
  try { token = await getAccessToken(); } catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) }; }
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  const userUrl = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(sendAs)}`;
  const encodedBytes = attachments.reduce((sum, attachment) => sum + Math.ceil(attachment.content.length / 3) * 4, 0);

  if (encodedBytes < SEND_MAIL_LIMIT) {
    const response = await fetch(`${userUrl}/sendMail`, { method: "POST", headers, body: JSON.stringify({ message: graphMessage(input, true), saveToSentItems: true }) });
    return response.status === 202 ? { ok: true, messageId: null } : responseError(response, "graph_send_failed");
  }

  const draftResponse = await fetch(`${userUrl}/messages`, { method: "POST", headers, body: JSON.stringify(graphMessage(input, false)) });
  if (!draftResponse.ok) return responseError(draftResponse, "graph_draft_failed");
  const draft = await draftResponse.json() as { id?: string };
  if (!draft.id) return { ok: false, error: "graph_draft_missing_id" };
  const messageUrl = `${userUrl}/messages/${encodeURIComponent(draft.id)}`;

  for (const attachment of attachments) {
    if (attachment.content.length <= SIMPLE_ATTACHMENT_LIMIT) {
      const response = await fetch(`${messageUrl}/attachments`, { method: "POST", headers, body: JSON.stringify(fileAttachment(attachment)) });
      if (!response.ok) return responseError(response, "graph_attachment_failed");
      continue;
    }

    const sessionResponse = await fetch(`${messageUrl}/attachments/createUploadSession`, {
      method: "POST", headers,
      body: JSON.stringify({ AttachmentItem: { attachmentType: "file", name: attachment.filename, size: attachment.content.length, contentType: attachment.contentType } }),
    });
    if (!sessionResponse.ok) return responseError(sessionResponse, "graph_upload_session_failed");
    const session = await sessionResponse.json() as { uploadUrl?: string };
    if (!session.uploadUrl) return { ok: false, error: "graph_upload_session_missing_url" };

    for (let start = 0; start < attachment.content.length; start += UPLOAD_CHUNK_SIZE) {
      const end = Math.min(start + UPLOAD_CHUNK_SIZE, attachment.content.length) - 1;
      const chunk = attachment.content.subarray(start, end + 1);
      const response = await fetch(session.uploadUrl, { method: "PUT", headers: { "Content-Length": String(chunk.length), "Content-Range": `bytes ${start}-${end}/${attachment.content.length}` }, body: Uint8Array.from(chunk) });
      if (!response.ok) return responseError(response, "graph_upload_failed");
    }
  }

  const sendResponse = await fetch(`${messageUrl}/send`, { method: "POST", headers });
  return sendResponse.status === 202 ? { ok: true, messageId: draft.id } : responseError(sendResponse, "graph_send_failed");
}
