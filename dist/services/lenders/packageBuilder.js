"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildLenderPackage = buildLenderPackage;
function buildLenderPackage(data) {
    const { application, documents, creditSummary, } = data;
    return {
        application,
        creditSummary,
        documents,
    };
}
