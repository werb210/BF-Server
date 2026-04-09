export const SYSTEM_CONTRACT = {
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
export function assertPipelineOrder(tabs) {
    if (JSON.stringify(tabs) !== JSON.stringify(SYSTEM_CONTRACT.pipelineTabs)) {
        throw new Error('Pipeline tab order violation');
    }
}
export function assertNoClientExposure(payload) {
    for (const field of SYSTEM_CONTRACT.restrictedFields) {
        if (payload[field]) {
            throw new Error(`Restricted field exposed: ${field}`);
        }
    }
}
export function assertImmutableAfterAcceptance(status, changes) {
    if (status === 'ACCEPTED' && Object.keys(changes).length > 0) {
        throw new Error('Mutation after acceptance is not allowed');
    }
}
