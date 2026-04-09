import { APPLICATION_TABS, MATCHING_RULES } from '../contracts/system.contract.js';
export function enforceTabOrder(tabs) {
    if (JSON.stringify(tabs) !== JSON.stringify(APPLICATION_TABS)) {
        throw new Error('SYSTEM CONTRACT VIOLATION: Tab order mismatch');
    }
}
export function enforceMatchingRules(input) {
    if (MATCHING_RULES.useLenderHQ === false && input.lenderHQUsed) {
        throw new Error('SYSTEM CONTRACT VIOLATION: Lender HQ used in matching');
    }
}
