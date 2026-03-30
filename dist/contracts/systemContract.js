"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SYSTEM_CONTRACT = void 0;
exports.assertPipelineOrder = assertPipelineOrder;
exports.assertNoClientExposure = assertNoClientExposure;
exports.assertImmutableAfterAcceptance = assertImmutableAfterAcceptance;
exports.SYSTEM_CONTRACT = {
    pipelineTabs: [
        'Application',
        'Financials',
        'Banking Analysis',
        'Credit Summary',
        'Documents',
        'Notes',
        'Lender Matching'
    ],
    restrictedFields: [
        'creditSummary',
        'financials',
        'bankingAnalysis',
        'commissionData'
    ],
    immutableAfterAcceptance: [
        'application',
        'documents',
        'commission'
    ]
};
function assertPipelineOrder(tabs) {
    if (JSON.stringify(tabs) !== JSON.stringify(exports.SYSTEM_CONTRACT.pipelineTabs)) {
        throw new Error('Pipeline tab order violation');
    }
}
function assertNoClientExposure(payload) {
    for (const field of exports.SYSTEM_CONTRACT.restrictedFields) {
        if (payload[field]) {
            throw new Error(`Restricted field exposed: ${field}`);
        }
    }
}
function assertImmutableAfterAcceptance(status, changes) {
    if (status === 'ACCEPTED' && Object.keys(changes).length > 0) {
        throw new Error('Mutation after acceptance is not allowed');
    }
}
