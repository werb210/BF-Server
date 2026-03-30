"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MATCHING_RULES = exports.DOCUMENT_RULES = exports.DATA_ACCESS = exports.APPLICATION_TABS = void 0;
exports.APPLICATION_TABS = [
    'Application',
    'Financials',
    'Banking Analysis',
    'Credit Summary',
    'Documents',
    'Notes',
    'Lender Matching'
];
exports.DATA_ACCESS = {
    client: {
        application: true,
        documents: true,
        financials: false,
        banking: false,
        creditSummary: false,
        notes: false,
        commission: false
    },
    lender: {
        application: true,
        documents: 'accepted_only',
        financials: false,
        banking: false,
        creditSummary: false,
        notes: false,
        commission: false
    },
    staff: {
        application: true,
        documents: true,
        financials: true,
        banking: true,
        creditSummary: true,
        notes: true,
        commission: true
    }
};
exports.DOCUMENT_RULES = {
    immutableAfterAcceptance: true,
    versioned: true,
    deletable: false
};
exports.MATCHING_RULES = {
    useLenderHQ: false,
    useProductCountryOnly: true,
    freezeAfterAcceptance: true
};
