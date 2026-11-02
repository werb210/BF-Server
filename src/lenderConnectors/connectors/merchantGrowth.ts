// BF_SERVER_v873_LENDER_API - Merchant Growth, shaped from their broker portal (17 screenshots Todd took on Oct 27 2026).
//
// AWAITING LENDER API DOCS. Merchant Growth has not published a broker API, and we have not been given one. Nothing in
// this file calls Merchant Growth: submitApplication and fetchStatus return "awaiting_lender_api_docs", and lenders on
// this connector keep receiving the package by email plus the Google Sheet row they asked for (dispatchToSelected).
//
// What the screenshots show (facts, not guesses):
//   * The broker portal is a Salesforce Experience Cloud site (merchantadvance.my.site.com) with Leads, Contacts,
//     Accounts, Opportunities and Tasks, plus portal.merchantadvance.com for Portfolio overview, Participation
//     overview, Commission Payment (by transferred date) and Residual Payment Summary.
//   * A deal starts as a Lead (status path ... First Call > Document Collection > Ready to Convert > Converted), then
//     becomes an Opportunity (stages Scoring & Quoting > Deal Offer Sent > Preliminary Review > Deal Administration >
//     Final Review > Ready to Fund, closed as "Closed - Rejected" with a Closed Reason such as "Failed Init Score").
//   * The broker is the "Channel" (Boreal Finance) and each record has a Lead Owner / Opportunity Owner and a Deal
//     Administrator at Merchant Growth.
//   * The offer ("Sold Quote", SQO) carries Tier, Merchant Score Grade, Funded Amount, Payment Amount, Split, Payment
//     Frequency, Buy Rate, Percentage of Sales, Sold Rate, APR and Refinance; the opportunity has Files (upload),
//     Contact Roles, Third Party Obligations and twelve months of Historical Sales.
// So this connector is a PRESET of the Salesforce connector (connectors/salesforce.ts): sign-in at the site's
// /services/oauth2/token, create a Lead, follow Lead.ConvertedOpportunityId to the Opportunity's StageName, attach files
// as ContentVersion, take Outbound Messages for stage changes. The standard Salesforce names in the preset (Lead,
// Company, FirstName, Status, ConvertedOpportunityId, Opportunity.StageName ...) are Salesforce's own; whether
// Merchant Growth uses those standard objects, and every custom field name (the Sold Quote fields, Use of Funds,
// Channel ...), is GUESSED until Merchant Growth sends documentation. Also guessed: the three lead statuses before
// First Call, the funded / closed-won stage name, and whether they will send Outbound Messages.
// MERCHANT_GROWTH_API_DOCS_RECEIVED stays false until a developer has their documentation and has corrected the preset;
// while it is false nothing is sent. A brokerage that gets API access sooner can use the plain Salesforce connector and
// map the fields from what Merchant Growth tells them.
import type { LenderBucket, LenderConnector, SubmitResult } from "../types.js";
import { AWAITING_DOCS_ERROR } from "../types.js";
import { salesforceConnector } from "./salesforce.js";

/** Flip only with Merchant Growth's API documentation in hand (and the preset below corrected from it). */
export const MERCHANT_GROWTH_API_DOCS_RECEIVED = false;

/**
 * The Salesforce settings the Merchant Growth preset starts from. Standard Salesforce names only; the custom fields
 * Merchant Growth shows (Use of Funds, Channel, Years in Business, Entity Type, Sold Quote) are left out until we know
 * their API names. guessed: true.
 */
export const MERCHANT_GROWTH_PRESET = {
  guessed: true,
  site_url: "https://merchantadvance.my.site.com",
  auth_flow: "password",
  submit: {
    object: "Lead",
    field_map: {
      Company: "company",
      FirstName: "firstName",
      LastName: "lastName",
      Email: "email",
      MobilePhone: "mobile",
      Phone: "phone",
      Street: "street",
      City: "city",
      State: "province",
      PostalCode: "postalCode",
      Country: "country",
      AnnualRevenue: "annualRevenue",
    },
    static_fields: {},
    attach_documents: true,
  },
  status: {
    object: "Lead",
    status_field: "Status",
    converted_field: "ConvertedOpportunityId",
    follow: { object: "Opportunity", status_field: "StageName", funded_amount_field: "Amount" },
  },
  webhook: { mode: "outbound_message", org_id: "", status_field: "StageName" },
} as const;

export type MgFieldMapping = {
  /** Where it appears in the Merchant Growth portal. */
  object: "Lead" | "Opportunity" | "Account";
  section: string;
  label: string;
  /** The Boreal value it would carry (mapping.ts SOURCE_KEYS), or null when Boreal does not collect it. */
  boreal: string | null;
  direction: "send" | "read";
  /** Salesforce field API name: unknown until Merchant Growth sends docs. */
  apiName: string | null;
  guessed: boolean;
};

const send = (object: MgFieldMapping["object"], section: string, label: string, boreal: string | null): MgFieldMapping =>
  ({ object, section, label, boreal, direction: "send", apiName: null, guessed: true });
const read = (object: MgFieldMapping["object"], section: string, label: string, boreal: string | null): MgFieldMapping =>
  ({ object, section, label, boreal, direction: "read", apiName: null, guessed: true });

/** Every field on the screenshots and what it maps to in Boreal. Labels are exact; API names are unknown. */
export const MERCHANT_GROWTH_FIELDS: MgFieldMapping[] = [
  // Lead - header and details (what a submission creates)
  send("Lead", "Header", "Company", "company"),
  send("Lead", "Header", "Mobile", "mobile"),
  send("Lead", "Header", "Email", "email"),
  send("Lead", "Header", "Channel", "brokerName"),
  send("Lead", "Details", "Requested Amount", "requestedAmount"),
  send("Lead", "Details", "Use of Funds Details", "useOfFunds"),
  read("Lead", "Details", "Lead Status", "lender status"),
  read("Lead", "Details", "Account Manager Notes", "lender note"),
  read("Lead", "Header", "Lead Owner", "lender contact"),
  read("Lead", "Header", "Deal Administrator", "lender contact"),
  // Lead - primary applicant
  send("Lead", "Primary Applicant", "Name", "firstName + lastName"),
  send("Lead", "Primary Applicant", "Email", "email"),
  send("Lead", "Primary Applicant", "Mobile", "mobile"),
  send("Lead", "Primary Applicant", "Home Address", null),
  send("Lead", "Primary Applicant", "Home City", null),
  send("Lead", "Primary Applicant", "Home Province", null),
  send("Lead", "Primary Applicant", "Home Zip", null),
  send("Lead", "Primary Applicant", "Owner Country", null),
  send("Lead", "Primary Applicant", "Date of Birth", "dob"),
  send("Lead", "Primary Applicant", "Owner Percentage", null),
  send("Lead", "Primary Applicant", "Social Insurance Number", null),
  // Lead - business
  send("Lead", "Business Details", "Company", "company"),
  send("Lead", "Business Details", "Legal Business Name", "company"),
  send("Lead", "Business Details", "Business Email", "email"),
  send("Lead", "Business Details", "Business Phone", "phone"),
  send("Lead", "Business Details", "Entity Type", "entityType"),
  send("Lead", "Business Details", "Years in Business", "yearsInBusiness"),
  send("Lead", "Business Details", "Industry", "industry"),
  send("Lead", "Business Details", "Sub-Industry", null),
  send("Lead", "Business Details", "Business Property Ownership Status", null),
  send("Lead", "Business Details", "Rent/Mortgage Amount", null),
  send("Lead", "Business Address", "Address (street, city, province, postal code, country)", "street, city, province, postalCode, country"),
  // Opportunity - what comes back
  read("Opportunity", "Header", "Stage", "lender status"),
  read("Opportunity", "Header", "Process", "lender note"),
  read("Opportunity", "Header", "SQO: Tier", "offer"),
  read("Opportunity", "Details", "Probability (%)", "lender note"),
  read("Opportunity", "Details", "Close Date", "lender note"),
  read("Opportunity", "Details", "Closed Reason", "decline reason"),
  read("Opportunity", "Details", "Additional Closing Notes", "decline reason"),
  read("Opportunity", "Details", "Requested Amount / CEBA Repayment Amount", "requestedAmount"),
  read("Opportunity", "Sold Quote Details", "Merchant Score Grade", "offer notes"),
  read("Opportunity", "Sold Quote Details", "Amount", "offer amount"),
  read("Opportunity", "Sold Quote Details", "SQO: Funded Amount", "offer amount / funded amount"),
  read("Opportunity", "Sold Quote Details", "SQO: Payment Amount", "offer notes"),
  read("Opportunity", "Sold Quote Details", "SQO: Payment Frequency", "offer payment frequency"),
  read("Opportunity", "Sold Quote Details", "SQO: Buy Rate", "offer rate / factor"),
  read("Opportunity", "Sold Quote Details", "SQO: Sold Rate", "offer rate / factor"),
  read("Opportunity", "Sold Quote Details", "SQO: Split", "offer notes"),
  read("Opportunity", "Sold Quote Details", "SQO: Percentage of Sales", "offer notes"),
  read("Opportunity", "Sold Quote Details", "SQO: APR", "offer notes"),
  read("Opportunity", "Sold Quote Details", "SQO: Refinance", "offer notes"),
  send("Opportunity", "Historical Sales", "Month 1-12 Total Sales", "monthlySales (one average today; Boreal has no month-by-month figures)"),
  read("Opportunity", "Related", "Files", "documents (upload)"),
  read("Opportunity", "Related", "Contact Roles", "lender contact"),
  read("Opportunity", "Related", "Third Party Obligations", "condition"),
  read("Account", "Details", "Renewals on Hold / Paid Percentage", "funded deal (renewals)"),
  read("Account", "Business Bank Information", "Bank Account Number / Financial Institution Name", null),
];

/** Lead statuses and opportunity stages seen on the screenshots, to Boreal buckets. */
export const MERCHANT_GROWTH_STATUS_MAP: Record<string, LenderBucket> = {
  "First Call": "in_review",
  "Document Collection": "documents_requested",
  "Ready to Convert": "in_review",
  "Converted": "in_review",
  "Scoring & Quoting": "in_review",
  "Deal Offer Sent": "offer",
  "Preliminary Review": "closing",
  "Deal Administration": "closing",
  "Final Review": "closing",
  "Ready to Fund": "closing",
  "Closed - Rejected": "declined",
};
/** Stage names we expect but did not see: confirm with Merchant Growth. */
export const MERCHANT_GROWTH_GUESSED_STATUSES: Record<string, LenderBucket> = {
  "Closed - Funded": "funded",
  "Closed Won": "funded",
};

/** What Todd (or any brokerage) must ask Merchant Growth for before this connector can be switched on. */
export const MERCHANT_GROWTH_REQUESTS: string[] = [
  "Written API documentation for brokers: how to create a deal (lead) and read back its lead status, opportunity stage, Sold Quote fields, conditions and file requests.",
  "API access for our broker partner user on merchantadvance.my.site.com: the \"API Enabled\" permission on the partner user's profile or a permission set, and a connected app (its consumer key and secret) that allows the username-password, client-credentials or JWT bearer sign-in for that user; or a separate partner API and keys.",
  "A sandbox (Salesforce sandbox or test endpoint) and test credentials.",
  "The object and field API names for every field on the Lead and Opportunity pages (custom fields end in __c), and the full list of lead statuses and opportunity stages, including the funded / closed-won name.",
  "How to upload files to an opportunity by API, and the document types they expect.",
  "Whether they will push stage changes to us: a Salesforce Outbound Message on Lead and Opportunity (we need their 18-character organization id) or a Flow HTTP callout signed with a shared secret. Otherwise Boreal polls every 30 minutes.",
  "Whether commission and residual payments (portal.merchantadvance.com) are available by API or as a report export.",
];

const awaiting: SubmitResult = { ok: false, error: AWAITING_DOCS_ERROR, retryable: false };

export const merchantGrowthConnector: LenderConnector = {
  kind: "merchant_growth",
  label: "Merchant Growth (Salesforce portal, awaiting their API documentation)",
  description: "A Salesforce preset shaped from Merchant Growth's broker portal. It cannot send anything until Merchant Growth gives us API documentation and access; until then their packages keep going by email and Google Sheet.",
  capabilities: { submit: true, status: true, upload: true, webhook: true },
  availability: MERCHANT_GROWTH_API_DOCS_RECEIVED ? "available" : "awaiting_lender_api_docs",
  secretFields: salesforceConnector.secretFields,
  validateConfig(config) {
    return MERCHANT_GROWTH_API_DOCS_RECEIVED ? salesforceConnector.validateConfig(config) : [];
  },
  defaultStatusMap() {
    return { ...MERCHANT_GROWTH_STATUS_MAP, ...MERCHANT_GROWTH_GUESSED_STATUSES };
  },
  async submitApplication(ctx, pkg) {
    return MERCHANT_GROWTH_API_DOCS_RECEIVED ? salesforceConnector.submitApplication(ctx, pkg) : awaiting;
  },
  async fetchStatus(ctx, externalId) {
    return MERCHANT_GROWTH_API_DOCS_RECEIVED ? salesforceConnector.fetchStatus!(ctx, externalId) : { ok: false, error: AWAITING_DOCS_ERROR, retryable: false };
  },
  async uploadDocument(ctx, externalId, doc) {
    return MERCHANT_GROWTH_API_DOCS_RECEIVED ? salesforceConnector.uploadDocument!(ctx, externalId, doc) : { ok: false, error: AWAITING_DOCS_ERROR, retryable: false };
  },
  parseWebhook(config, body) {
    return MERCHANT_GROWTH_API_DOCS_RECEIVED ? salesforceConnector.parseWebhook!(config, body) : [];
  },
  async testConnection(ctx) {
    if (MERCHANT_GROWTH_API_DOCS_RECEIVED) return salesforceConnector.testConnection!(ctx);
    return { ok: false, message: "Merchant Growth has not given us API documentation yet, so there is nothing to test. Their packages keep going by email and Google Sheet." };
  },
};
