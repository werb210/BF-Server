"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.enforceTabOrder = enforceTabOrder;
exports.enforceMatchingRules = enforceMatchingRules;
const system_contract_1 = require("../contracts/system.contract");
function enforceTabOrder(tabs) {
    if (JSON.stringify(tabs) !== JSON.stringify(system_contract_1.APPLICATION_TABS)) {
        throw new Error('SYSTEM CONTRACT VIOLATION: Tab order mismatch');
    }
}
function enforceMatchingRules(input) {
    if (system_contract_1.MATCHING_RULES.useLenderHQ === false && input.lenderHQUsed) {
        throw new Error('SYSTEM CONTRACT VIOLATION: Lender HQ used in matching');
    }
}
