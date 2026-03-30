"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.OcrStorageValidationError = void 0;
exports.createOcrStorage = createOcrStorage;
const storage_blob_1 = require("@azure/storage-blob");
const logger_1 = require("../../observability/logger");
const config_1 = require("../../config");
const AZURE_BLOB_HOST_SUFFIXES = [
    ".blob.core.windows.net",
    ".blob.core.usgovcloudapi.net",
    ".blob.core.chinacloudapi.cn",
    ".blob.core.cloudapi.de",
];
class OcrStorageValidationError extends Error {
    url;
    constructor(url) {
        super("invalid_ocr_storage_url");
        this.name = "OcrStorageValidationError";
        this.url = url;
    }
}
exports.OcrStorageValidationError = OcrStorageValidationError;
function parseDataUrl(content) {
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
function isAllowedAzureBlobUrl(value) {
    let parsed;
    try {
        parsed = new URL(value);
    }
    catch {
        return false;
    }
    if (parsed.protocol !== "https:") {
        return false;
    }
    const hostname = parsed.hostname.toLowerCase();
    return AZURE_BLOB_HOST_SUFFIXES.some((suffix) => hostname.endsWith(suffix));
}
async function downloadAzureBlobFromUrl(url) {
    const client = new storage_blob_1.BlobClient(url);
    return client.downloadToBuffer();
}
async function downloadAzureBlobFromPath(pathValue) {
    const match = /^azure:\/\/([^/]+)\/(.+)$/.exec(pathValue);
    if (!match) {
        throw new Error("invalid_azure_blob_path");
    }
    const connectionString = config_1.config.azureStorage.connectionString;
    if (!connectionString) {
        (0, logger_1.logWarn)("azure_storage_missing_connection_string", {
            code: "azure_storage_missing_connection_string",
        });
        throw new Error("missing_azure_storage_connection_string");
    }
    const container = match[1];
    const blobName = match[2];
    if (!container || !blobName) {
        throw new Error("invalid_azure_blob_path");
    }
    const serviceClient = storage_blob_1.BlobServiceClient.fromConnectionString(connectionString);
    const blobClient = serviceClient.getContainerClient(container).getBlobClient(blobName);
    return blobClient.downloadToBuffer();
}
function createOcrStorage() {
    return {
        async fetchBuffer(input) {
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
