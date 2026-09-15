// BF_SERVER_MISFILED_DOCS_v262
// "Filed as X, looks like Y" for the portal Documents tab, from what server OCR
// already stored (detected_type / detected_confidence, category_before_retag).
import { resolveExpectedDocumentKey } from "./classifyDocument.js";

export const MISFILED_CONFIDENCE = 0.6;

const LABELS: Record<string, string> = {
  bank_statements_6_months: "bank statements",
  tax_returns: "tax returns",
  financial_statements: "financial statements",
  void_cheque: "a void cheque",
  government_id: "government ID",
  articles_of_incorporation: "articles of incorporation",
  accounts_receivable_aging: "an A/R aging report",
  accounts_payable_aging: "an A/P aging report",
  equipment_quote: "an equipment quote",
  equipment_invoice: "an equipment invoice",
  personal_net_worth: "a personal net worth statement",
};

export function documentTypeLabel(key: string | null | undefined): string | null {
  if (!key) return null;
  return LABELS[key] ?? key.replace(/_/g, " ");
}

export type ClassificationRow = {
  document_type: string | null;
  category: string | null;
  category_before_retag: string | null;
  detected_type: string | null;
  detected_confidence: number | string | null;
};

export type MisfiledSignal = {
  detectedType: string | null;
  detectedLabel: string | null;
  detectedConfidence: number | null;
  looksMisfiled: boolean;
  autoMovedFrom: string | null;
};

export function misfiledSignal(row: ClassificationRow): MisfiledSignal {
  const detectedType = row.detected_type ?? null;
  const confidence = row.detected_confidence === null || row.detected_confidence === undefined ? null : Number(row.detected_confidence);
  const filedAs = resolveExpectedDocumentKey(row.document_type ?? row.category);
  const confident = confidence !== null && Number.isFinite(confidence) && confidence >= MISFILED_CONFIDENCE;
  const movedFrom = row.category_before_retag && row.category && row.category !== row.category_before_retag ? row.category_before_retag : null;
  return {
    detectedType,
    detectedLabel: documentTypeLabel(detectedType),
    detectedConfidence: confidence,
    looksMisfiled: Boolean(detectedType && confident && filedAs && detectedType !== filedAs),
    autoMovedFrom: movedFrom,
  };
}
