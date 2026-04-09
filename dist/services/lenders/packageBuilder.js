export function buildLenderPackage(data) {
    const { application, documents, creditSummary, } = data;
    return {
        application,
        creditSummary,
        documents,
    };
}
