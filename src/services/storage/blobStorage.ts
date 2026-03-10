import { BlobServiceClient, type BlockBlobUploadOptions } from "@azure/storage-blob";
import { hashBuffer } from "../documents/hashService";

const connectionString = process.env.AZURE_STORAGE_CONNECTION_STRING;
const containerName = process.env.DOCUMENT_CONTAINER || "documents";

let containerClient: ReturnType<BlobServiceClient["getContainerClient"]> | null = null;

function getContainerClient() {
  if (!connectionString) {
    throw new Error("AZURE_STORAGE_CONNECTION_STRING missing");
  }

  if (!containerClient) {
    const blobServiceClient = BlobServiceClient.fromConnectionString(connectionString);
    containerClient = blobServiceClient.getContainerClient(containerName);
  }

  return containerClient;
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
