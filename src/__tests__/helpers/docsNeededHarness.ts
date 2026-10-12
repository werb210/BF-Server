// BF_SERVER_v789_SG5 - SQL answers for behaviour tests of src/routes/clientDocumentsNeeded.ts.
// The test file mocks ../db.js (and sbaTrigger / documentSharing) itself; these rules answer each
// source the required-document set is built from, by what the query asks for.
import type { SqlRule } from "./answerBySql.js";

export type DocsNeededFixture = {
  /** applications.metadata (wizard-stored productRequirements live here). */
  metadata?: Record<string, unknown> | null;
  /** lender_products.required_documents of the finalized product. */
  productDocs?: unknown[] | null;
  /** applications.product_category. */
  category?: string | null;
  /** application_document_requests rows (staff Request Items). */
  requested?: string[];
  /** uploaded documents in the family: category + status. */
  uploaded?: Array<{ category: string; status: string | null }>;
  /** application_document_waivers. */
  waived?: string[];
};

export function docsNeededRules(f: DocsNeededFixture): SqlRule[] {
  const uploaded = f.uploaded ?? [];
  return [
    [/SELECT d\.category, d\.status FROM documents d/, { rows: uploaded }],
    [/SELECT DISTINCT d\.category FROM documents d/, { rows: uploaded.filter((u) => u.status !== "rejected").map((u) => ({ category: u.category })) }],
    [/SELECT metadata FROM applications WHERE id::text = \(\$1\)::text/, { rows: f.metadata === undefined ? [] : [{ metadata: f.metadata }] }],
    [/SELECT lp\.required_documents/, { rows: f.productDocs ? [{ required_documents: f.productDocs }] : [] }],
    [/SELECT product_category FROM applications WHERE id::text = \(\$1\)::text/, { rows: [{ product_category: f.category ?? null }] }],
    [/FROM application_document_requests/, { rows: (f.requested ?? []).map((document_type) => ({ document_type })) }],
    [/FROM application_document_waivers/, { rows: (f.waived ?? []).map((document_type) => ({ document_type })) }],
  ];
}

/** Wizard metadata carrying the product's requirement list the way Step 5 stores it. */
export function wizardRequirements(items: unknown[]): Record<string, unknown> {
  return { formData: { productRequirements: { aggregated: items } } };
}
