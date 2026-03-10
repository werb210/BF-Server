import { BlobServiceClient, type BlockBlobUploadOptions } from "@azure/storage-blob";
import { hashBuffer } from "../documents/hashService";

export function getContainerClient() {
  if (process.env.NODE_ENV === "test") {
    return {
      getBlockBlobClient: () => ({
        uploadData: async () => ({ etag: "test-etag" }),
        upload: async () => ({ etag: "test-etag" }),
        delete: async () => {},
        download: async () => ({
          readableStreamBody: Buffer.from("test"),
        }),
      }),
    } as any;
  }

  const connectionString = process.env.AZURE_STORAGE_CONNECTION_STRING;

  if (!connectionString) {
    throw new Error("AZURE_STORAGE_CONNECTION_STRING missing");
  }

  const blobServiceClient = BlobServiceClient.fromConnectionString(connectionString);

  return blobServiceClient.getContainerClient(
    process.env.AZURE_STORAGE_CONTAINER || "documents"
  );
}

export async function pingStorage(): Promise<void> {
  await getContainerClient().exists();
}

export async function uploadDocumentBuffer(params: {
  buffer: Buffer;
  filename: string;
  contentType?: string;
}) {
  const hash = hashBuffer(params.buffer);
  const blobName = `${Date.now()}-${hash}-${params.filename}`;

  const blockBlob = getContainerClient().getBlockBlobClient(blobName);
  const options: BlockBlobUploadOptions = params.contentType
    ? { blobHTTPHeaders: { blobContentType: params.contentType } }
    : {};

  await blockBlob.uploadData(params.buffer, options);

  return {
    blobName,
    hash,
    url: blockBlob.url,
  };
}
