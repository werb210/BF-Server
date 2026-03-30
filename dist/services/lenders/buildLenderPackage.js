"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildLenderPackage = buildLenderPackage;
function buildLenderPackage(application, documents, creditSummary) {
    return {
        application,
        documents,
        creditSummary,
    };
}
