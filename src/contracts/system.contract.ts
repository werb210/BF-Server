export const APPLICATION_TABS = [
  'Application',
  'Financials',
  'Banking Analysis',
  'Credit Summary',
  'Documents',
  'Notes',
  'Lender Matching'
] as const;

export type ApplicationTab = typeof APPLICATION_TABS[number];

export const DATA_ACCESS = {
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
} as const;

export const DOCUMENT_RULES = {
  immutableAfterAcceptance: true,
  versioned: true,
  deletable: false
};

export const MATCHING_RULES = {
  useLenderHQ: false,
  useProductCountryOnly: true,
  freezeAfterAcceptance: true
};
