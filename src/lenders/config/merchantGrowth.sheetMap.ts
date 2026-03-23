export type GoogleSheetsPayload = {
  application: {
    id: string;
    ownerUserId: string | null;
    name: string;
    metadata: unknown;
    productType: string;
    lenderId: string | null;
    lenderProductId: string | null;
    requestedAmount: number | null;
  };
  documents: Array<{
    documentId: string;
    documentType: string;
    title: string;
    versionId: string;
    version: number;
    metadata: unknown;
    content: string;
  }>;
  submittedAt: string;
};

export type SheetMapColumn = {
  header: string;
  value: (payload: GoogleSheetsPayload) => string | number | null;
};

export type GoogleSheetsSheetMap = {
  columns: SheetMapColumn[];
  applicationIdHeader: string;
};

export const MERCHANT_GROWTH_LENDER_NAME = "Merchant Growth";

function fetchMetadata(payload: GoogleSheetsPayload): Record<string, unknown> {
  if (payload.application.metadata && typeof payload.application.metadata === "object") {
    return payload.application.metadata as Record<string, unknown>;
  }
  return {};
}

function fetchApplicant(payload: GoogleSheetsPayload): Record<string, unknown> {
  const metadata = fetchMetadata(payload);
  const applicant = metadata.applicant;
  return applicant && typeof applicant === "object" ? (applicant as Record<string, unknown>) : {};
}

function fetchBusiness(payload: GoogleSheetsPayload): Record<string, unknown> {
  const metadata = fetchMetadata(payload);
  const business = metadata.business;
  return business && typeof business === "object" ? (business as Record<string, unknown>) : {};
}

function fetchBusinessAddress(payload: GoogleSheetsPayload): Record<string, unknown> {
  const business = fetchBusiness(payload);
  const address = business.address;
  return address && typeof address === "object" ? (address as Record<string, unknown>) : {};
}

function fetchFinancials(payload: GoogleSheetsPayload): Record<string, unknown> {
  const metadata = fetchMetadata(payload);
  const financials = metadata.financials ?? metadata.revenue ?? metadata.banking;
  return financials && typeof financials === "object"
    ? (financials as Record<string, unknown>)
    : {};
}

function asString(value: unknown): string {
  if (typeof value === "string") {
    return value.trim();
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  return "";
}

function asNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  const parsed = typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

export const MERCHANT_GROWTH_SHEET_MAP: GoogleSheetsSheetMap = {
  applicationIdHeader: "Application ID",
  columns: [
    {
      header: "Application ID",
      value: (payload) => payload.application.id,
    },
    {
      header: "Submitted At",
      value: (payload) => payload.submittedAt,
    },
    {
      header: "Applicant First Name",
      value: (payload) => asString(fetchApplicant(payload).firstName),
    },
    {
      header: "Applicant Last Name",
      value: (payload) => asString(fetchApplicant(payload).lastName),
    },
    {
      header: "Applicant Email",
      value: (payload) => asString(fetchApplicant(payload).email),
    },
    {
      header: "Applicant Phone",
      value: (payload) => asString(fetchApplicant(payload).phone),
    },
    {
      header: "Business Legal Name",
      value: (payload) => asString(fetchBusiness(payload).legalName),
    },
    {
      header: "Business Tax ID",
      value: (payload) => asString(fetchBusiness(payload).taxId),
    },
    {
      header: "Business Entity Type",
      value: (payload) => asString(fetchBusiness(payload).entityType),
    },
    {
      header: "Business Address Line 1",
      value: (payload) => asString(fetchBusinessAddress(payload).line1),
    },
    {
      header: "Business City",
      value: (payload) => asString(fetchBusinessAddress(payload).city),
    },
    {
      header: "Business State",
      value: (payload) => asString(fetchBusinessAddress(payload).state),
    },
    {
      header: "Business Postal Code",
      value: (payload) => asString(fetchBusinessAddress(payload).postalCode),
    },
    {
      header: "Business Country",
      value: (payload) => asString(fetchBusinessAddress(payload).country),
    },
    {
      header: "Requested Amount",
      value: (payload) => payload.application.requestedAmount ?? null,
    },
    {
      header: "Product Type",
      value: (payload) => payload.application.productType,
    },
    {
      header: "Requested Term",
      value: (payload) => asString(fetchFinancials(payload).term),
    },
    {
      header: "Annual Revenue",
      value: (payload) =>
        asNumber((fetchFinancials(payload).annualRevenue ?? fetchFinancials(payload).annual) as unknown),
    },
    {
      header: "Monthly Revenue",
      value: (payload) =>
        asNumber((fetchFinancials(payload).monthlyRevenue ?? fetchFinancials(payload).monthly) as unknown),
    },
    {
      header: "Banking Summary",
      value: (payload) => asString(fetchFinancials(payload).bankingSummary),
    },
  ],
};
