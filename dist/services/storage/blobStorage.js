"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.blobStorage = void 0;
exports.uploadDocumentBuffer = uploadDocumentBuffer;
async function uploadDocumentBuffer(_params) {
    return {
        blobName: "mock-blob-name",
        url: "mock-url",
        hash: "mock-hash",
    };
}
exports.blobStorage = {
    async upload() {
        return { url: "mock-url" };
    },
    async exists() {
        return true;
    },
    async pingStorage() {
        return true;
    },
};
