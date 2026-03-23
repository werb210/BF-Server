import { BlobClient, BlobServiceClient } from "@azure/storage-blob";
import { logWarn } from "../../observability/logger";
import { config } from "@/config";

export type OcrStorageInput = {
  content: string;
};

export type OcrStorage = {
  fetchBuffer: (input: OcrStorageInput) => Promise<Buffer>;
};

const AZURE_BLOB_HOST_SUFFIXES = [
  ".blob.core.windows.net",
  ".blob.core.usgovcloudapi.net",
  ".blob.core.chinacloudapi.cn",
  ".blob.core.cloudapi.de",
];

export class OcrStorageValidationError extends Error {
  readonly url: string;

  constructor(url: string) {
    super("invalid_ocr_storage_url");
    this.name = "OcrStorageValidationError";
    this.url = url;
  }
}

function parseDataUrl(content: string): Buffer | null {
  if (!content.startsWith("data:")) {
    return null;
  }
  const splitIndex = content.indexOf(",");
  if (splitIndex === -1) {
    return null;
  }
  const base64 = content.slice(splitIndex + 1);
  return Buffer.from(base64, "base64");
}

function isAllowedAzureBlobUrl(value: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:") {
    return false;
  }
  const hostname = parsed.hostname.toLowerCase();
  return AZURE_BLOB_HOST_SUFFIXES.some((suffix) => hostname.endsWith(suffix));
}

async function downloadAzureBlobFromUrl(url: string): Promise<Buffer> {
  const client = new BlobClient(url);
  return client.downloadToBuffer();
}

async function downloadAzureBlobFromPath(pathValue: string): Promise<Buffer> {
  const match = /^azure:\/\/([^/]+)\/(.+)$/.exec(pathValue);
  if (!match) {
    throw new Error("invalid_azure_blob_path");
  }
  const connectionString = config.azureStorage.connectionString;
  if (!connectionString) {
    logWarn("azure_storage_missing_connection_string", {
      code: "azure_storage_missing_connection_string",
    });
    throw new Error("missing_azure_storage_connection_string");
  }
  const container = match[1];
  const blobName = match[2];
  if (!container || !blobName) {
    throw new Error("invalid_azure_blob_path");
  }
  const serviceClient = BlobServiceClient.fromConnectionString(connectionString);
  const blobClient = serviceClient.getContainerClient(container).getBlobClient(blobName);
  return blobClient.downloadToBuffer();
}

export function createOcrStorage(): OcrStorage {
  return {
    async fetchBuffer(input: OcrStorageInput): Promise<Buffer> {
      const dataUrlBuffer = parseDataUrl(input.content);
      if (dataUrlBuffer) {
        return dataUrlBuffer;
      }
      if (input.content.startsWith("https://")) {
        if (!isAllowedAzureBlobUrl(input.content)) {
          throw new OcrStorageValidationError(input.content);
        }
        return downloadAzureBlobFromUrl(input.content);
      }
      if (input.content.startsWith("azure://")) {
        return downloadAzureBlobFromPath(input.content);
      }
      if (input.content.startsWith("http://")) {
        throw new OcrStorageValidationError(input.content);
      }
      return Buffer.from(input.content, "base64");
    },
  };
}
