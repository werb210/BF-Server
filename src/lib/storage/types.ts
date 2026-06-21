// BF_AZURE_OCR_TERMSHEET_v44 — storage interface
export interface PutResult {
  blobName: string;
  url: string;
  hash: string;
  sizeBytes: number;
}

export interface StorageBackend {
  put(params: {
    buffer: Buffer;
    filename: string;
    contentType: string;
    pathPrefix?: string;
  }): Promise<PutResult>;
  get(blobName: string): Promise<{ buffer: Buffer; contentType: string } | null>;
  // Short-lived read URL for in-browser viewing (Azure SAS). Optional: the local
  // backend returns null and callers fall back to streaming through the server.
  getSignedUrl?(blobName: string, expiresInSeconds?: number): Promise<string | null>;
  delete(blobName: string): Promise<void>;
  ping(): Promise<boolean>;
  describe(): { kind: "azure" | "local"; container?: string };
}
