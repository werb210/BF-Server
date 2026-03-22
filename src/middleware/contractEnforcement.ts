import { APPLICATION_TABS, MATCHING_RULES } from '../contracts/system.contract';

export function enforceTabOrder(tabs: string[]) {
  if (JSON.stringify(tabs) !== JSON.stringify(APPLICATION_TABS)) {
    throw new Error('SYSTEM CONTRACT VIOLATION: Tab order mismatch');
  }
}

export function enforceMatchingRules(input: any) {
  if (MATCHING_RULES.useLenderHQ === false && input.lenderHQUsed) {
    throw new Error('SYSTEM CONTRACT VIOLATION: Lender HQ used in matching');
  }
}
