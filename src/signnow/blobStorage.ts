// BF_SERVER_BLOCK_v201_SIGNNOW_REAL_BUILD_v1
import { AzureBlobBackend } from "../lib/storage/azureBlob.js";
const CONTAINER = process.env.SIGNNOW_BLOB_CONTAINER || "signed-applications";
let cached: AzureBlobBackend | null = null;
function getBackend(): AzureBlobBackend | null {
  if (cached) return cached;
  const conn = process.env.AZURE_STORAGE_CONNECTION_STRING;
  if (!conn) return null;
  cached = new AzureBlobBackend(CONTAINER, conn);
  return cached;
}
export async function uploadSignedApplicationPdf(applicationId: string, buffer: Buffer): Promise<{ blobName: string; url: string; sizeBytes: number; hash: string }> {
  const b = getBackend();
  if (!b) throw new Error("AZURE_STORAGE_CONNECTION_STRING not configured");
  await b.ping().catch(() => {});
  const result = await b.put({ buffer, filename: `signed-application-${applicationId}.pdf`, contentType: "application/pdf", pathPrefix: applicationId });
  return { blobName: result.blobName, url: result.url, sizeBytes: result.sizeBytes, hash: result.hash };
}
