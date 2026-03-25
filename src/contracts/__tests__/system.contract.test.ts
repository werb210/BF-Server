import { APPLICATION_TABS, MATCHING_RULES, DOCUMENT_RULES } from '../system.contract';

describe('SYSTEM CONTRACT ENFORCEMENT', () => {

  it('tab order must never change', () => {
    expect(APPLICATION_TABS).toEqual([
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
    expect(MATCHING_RULES.useLenderHQ).toBe(false);
  });

  it('documents must be immutable after acceptance', () => {
    expect(DOCUMENT_RULES.immutableAfterAcceptance).toBe(true);
  });

});
