"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const system_contract_1 = require("../system.contract");
describe('SYSTEM CONTRACT ENFORCEMENT', () => {
    it('tab order must never change', () => {
        expect(system_contract_1.APPLICATION_TABS).toEqual([
            'Application',
            'Financials',
            'Banking Analysis',
            'Credit Summary',
            'Documents',
            'Notes',
            'Lender Matching'
        ]);
    });
    it('must not use lender HQ for matching', () => {
        expect(system_contract_1.MATCHING_RULES.useLenderHQ).toBe(false);
    });
    it('documents must be immutable after acceptance', () => {
        expect(system_contract_1.DOCUMENT_RULES.immutableAfterAcceptance).toBe(true);
    });
});
