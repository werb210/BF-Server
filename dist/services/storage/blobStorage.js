export async function uploadDocumentBuffer(_params) {
    return {
        blobName: "mock-blob-name",
        url: "mock-url",
        hash: "mock-hash",
    };
}
export const blobStorage = {
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
