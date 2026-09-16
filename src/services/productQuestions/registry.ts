// BF_SERVER_PRODUCT_QUESTIONS_v288
export type QuestionType = "text" | "yesno" | "money" | "month" | "yearmonth" | "number" | "select";
export type Scope = "business" | "owner" | "kyc";
export type Question = { key: string; label: string; type: QuestionType; scope: Scope; section: "business" | "owner" | "risk" | "equipment"; required: boolean; options?: string[]; showIf?: { key: string; equals: string } };
export type QuestionSetId = "loc_accord" | "equipment";
const RISK = [
  ["riskMultipleLocations", "Does the business operate more than one location?"],
  ["riskBusinessBankruptcy", "Has the business ever filed for bankruptcy, CCAA, or a proposal?"],
  ["riskOwnerBankruptcyPersonal", "Has any owner / officer / director filed personal bankruptcy or a proposal?"],
  ["riskOwnerBankruptcyOtherBiz", "Has any owner / officer / director filed bankruptcy, CCAA, or a proposal for any other business?"],
  ["riskGovtArrears", "Any past-due government balances (Source Deductions, GST/HST, PST, income tax, EHT)?"],
] as const;
export const QUESTION_SETS: Record<QuestionSetId, { label: string; questions: Question[] }> = {
  loc_accord: { label: "Line of Credit", questions: [
    { key: "fiscalYearEnd", label: "Fiscal year-end month", type: "month", scope: "business", section: "business", required: true },
    { key: "inBusinessSince", label: "Month and year the business started", type: "yearmonth", scope: "business", section: "business", required: true },
    { key: "craBusinessNumber", label: "CRA business number", type: "text", scope: "business", section: "business", required: false },
    { key: "mailingSameAsOperating", label: "Is the mailing address the same as the operating address?", type: "yesno", scope: "business", section: "business", required: true },
    ...["Address|street address", "City|city", "State|province or state", "Zip|postal or ZIP code"].map((x) => { const [suffix, label] = x.split("|"); return { key: `mailing${suffix}`, label: `Mailing ${label}`, type: "text" as const, scope: "business" as const, section: "business" as const, required: true, showIf: { key: "mailingSameAsOperating", equals: "No" } }; }),
    ...RISK.flatMap(([key, label]) => [
      { key, label, type: "yesno" as const, scope: "business" as const, section: "risk" as const, required: true },
      { key: `${key}Detail`, label: "Please provide details", type: "text" as const, scope: "business" as const, section: "risk" as const, required: true, showIf: { key, equals: "Yes" } },
    ]),
    { key: "title", label: "Title", type: "text", scope: "owner", section: "owner", required: false },
    { key: "homePhone", label: "Home phone", type: "text", scope: "owner", section: "owner", required: false },
    { key: "addressSince", label: "At this address since (month and year)", type: "yearmonth", scope: "owner", section: "owner", required: true },
    { key: "ownRent", label: "Own or rent your home?", type: "select", options: ["Own", "Rent"], scope: "owner", section: "owner", required: true },
    ...[["propertyValue", "Property value"], ["mortgageBalance", "Mortgage balance"]].map(([key, label]) => ({ key, label, type: "money" as const, scope: "owner" as const, section: "owner" as const, required: true, showIf: { key: "ownRent", equals: "Own" } })),
    { key: "director", label: "Director?", type: "yesno", scope: "owner", section: "owner", required: true },
    { key: "officer", label: "Officer?", type: "yesno", scope: "owner", section: "owner", required: true },
    { key: "bankruptcyFiled", label: "Ever filed bankruptcy or a proposal?", type: "yesno", scope: "owner", section: "owner", required: true },
    { key: "bankruptcyWhen", label: "If yes, when? (month / year)", type: "text", scope: "owner", section: "owner", required: true, showIf: { key: "bankruptcyFiled", equals: "Yes" } },
  ] },
  equipment: { label: "Equipment Finance", questions: [
    { key: "equipmentAmount", label: "Cost of the equipment", type: "money", scope: "kyc", section: "equipment", required: true },
    { key: "purposeOfFunds", label: "What is the equipment for?", type: "select", scope: "kyc", section: "equipment", required: true, options: ["Buy New Equipment", "Replace Existing Equipment", "Purchase more equipment to expand", "Lease Back to access capital"] },
  ] },
};
export function questionSetFor(category: unknown, accordMatched: boolean): QuestionSetId | null {
  const c = String(category ?? "").trim().toUpperCase().replace(/[\s\-/]+/g, "_");
  if ((c === "LINE_OF_CREDIT" || c === "LOC") && accordMatched) return "loc_accord";
  if (["EQUIPMENT_FINANCE", "EQUIPMENT", "EQUIPMENT_FINANCING"].includes(c)) return "equipment";
  return null;
}
