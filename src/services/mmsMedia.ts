// BF_SERVER_MMS_MEDIA_HELPER_v1 - inbound MMS media handling.
// Fetches media from Twilio (with the api.twilio.com -> S3 redirect fix) and
// persists it to a public Azure Blob container so staff can render the image
// without Twilio creds at view time and without depending on Twilio retention
// (Twilio purges media; its URLs eventually 404 -> "broken image").
import { randomUUID } from "node:crypto";
import { BlobServiceClient } from "@azure/storage-blob";

function extFromContentType(ct: string): string {
  const m = (ct || "").toLowerCase();
  if (m.includes("jpeg") || m.includes("jpg")) return ".jpg";
  if (m.includes("png")) return ".png";
  if (m.includes("gif")) return ".gif";
  if (m.includes("webp")) return ".webp";
  if (m.includes("heic")) return ".heic";
  if (m.includes("pdf")) return ".pdf";
  if (m.includes("mp4")) return ".mp4";
  return "";
}

/**
 * Download a Twilio media URL. Twilio's MediaUrlN (api.twilio.com) requires Basic
 * auth and 307-redirects to a presigned CDN/S3 URL. We send auth ONLY to
 * api.twilio.com and follow the redirect WITHOUT the Authorization header, because
 * forwarding it to S3 makes S3 reject the request (a common cause of broken MMS).
 */
export async function fetchTwilioMedia(
  url: string,
): Promise<{ buffer: Buffer; contentType: string } | null> {
  const sid = process.env.TWILIO_ACCOUNT_SID ?? "";
  const tok = process.env.TWILIO_AUTH_TOKEN ?? "";
  const isTwilio = /api\.twilio\.com/.test(url);
  const headers: Record<string, string> = {};
  if (isTwilio && sid && tok) {
    headers.Authorization = "Basic " + Buffer.from(`${sid}:${tok}`).toString("base64");
  }
  try {
    let resp = await fetch(url, { headers, redirect: "manual" });
    if (resp.status >= 300 && resp.status < 400) {
      const loc = resp.headers.get("location");
      if (loc) resp = await fetch(loc);
    }
    if (!resp.ok) {
      // eslint-disable-next-line no-console
      console.error({ event: "mms_media_fetch_fail", status: resp.status, twilio: isTwilio });
      return null;
    }
    const contentType = resp.headers.get("content-type") || "application/octet-stream";
    const buffer = Buffer.from(await resp.arrayBuffer());
    return { buffer, contentType };
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error({ event: "mms_media_fetch_error", err: String(err) });
    return null;
  }
}

/** Upload bytes to the public mms-inbound blob container; returns the public URL. */
export async function uploadInboundMmsBlob(
  buffer: Buffer,
  contentType: string,
): Promise<string | null> {
  const conn = process.env.AZURE_STORAGE_CONNECTION_STRING;
  if (!conn) return null;
  try {
    const containerName = process.env.AZURE_STORAGE_CONTAINER_MMS || "mms-inbound";
    const svc = BlobServiceClient.fromConnectionString(conn);
    const container = svc.getContainerClient(containerName);
    await container.createIfNotExists({ access: "blob" });
    const blob = container.getBlockBlobClient(`sms/${randomUUID()}${extFromContentType(contentType)}`);
    await blob.uploadData(buffer, {
      blobHTTPHeaders: { blobContentType: contentType || "application/octet-stream" },
    });
    return blob.url;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error({ event: "mms_blob_upload_fail", err: String(err) });
    return null;
  }
}

/** Fetch a raw Twilio media URL and persist it to public blob (returns bytes too). */
export async function persistTwilioMediaToBlob(
  twilioUrl: string,
): Promise<{ url: string; contentType: string; buffer: Buffer } | null> {
  const fetched = await fetchTwilioMedia(twilioUrl);
  if (!fetched) return null;
  const url = await uploadInboundMmsBlob(fetched.buffer, fetched.contentType);
  if (!url) return null;
  return { url, contentType: fetched.contentType, buffer: fetched.buffer };
}
