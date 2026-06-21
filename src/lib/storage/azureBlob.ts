// BF_AZURE_OCR_TERMSHEET_v44 — Azure Blob backend
import { BlobServiceClient, ContainerClient } from "@azure/storage-blob";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import type { StorageBackend, PutResult } from "./types.js";

export class AzureBlobBackend implements StorageBackend {
  private client: ContainerClient;
  constructor(private container: string, connectionString: string) {
    const svc = BlobServiceClient.fromConnectionString(connectionString);
    this.client = svc.getContainerClient(container);
  }

  async put(p: { buffer: Buffer; filename: string; contentType: string; pathPrefix?: string }): Promise<PutResult> {
    const ext = path.extname(p.filename) || "";
    const id = randomUUID();
    const blobName = `${p.pathPrefix ? p.pathPrefix.replace(/^\/+|\/+$/g, "") + "/" : ""}${id}${ext}`;
    const blob = this.client.getBlockBlobClient(blobName);
    await blob.uploadData(p.buffer, {
      blobHTTPHeaders: { blobContentType: p.contentType || "application/octet-stream" },
    });
    const hash = createHash("sha256").update(p.buffer).digest("hex");
    return { blobName, url: blob.url, hash, sizeBytes: p.buffer.length };
  }

  async get(blobName: string) {
    const blob = this.client.getBlockBlobClient(blobName);
    if (!(await blob.exists())) return null;
    const buf = await blob.downloadToBuffer();
    const props = await blob.getProperties();
    return { buffer: buf, contentType: props.contentType ?? "application/octet-stream" };
  }

  async getSignedUrl(blobName: string, expiresInSeconds = 86400): Promise<string | null> {
    try {
      const { BlobSASPermissions } = await import("@azure/storage-blob");
      const blob = this.client.getBlockBlobClient(blobName);
      return await blob.generateSasUrl({
        permissions: BlobSASPermissions.parse("r"),
        expiresOn: new Date(Date.now() + expiresInSeconds * 1000),
        contentType: "application/pdf",
        contentDisposition: "inline",
      });
    } catch { return null; }
  }

  async delete(blobName: string) {
    await this.client.getBlockBlobClient(blobName).deleteIfExists();
  }

  async ping() {
    try { await this.client.createIfNotExists(); return true; } catch { return false; }
  }

  describe() {
    return { kind: "azure" as const, container: this.container };
  }
}
