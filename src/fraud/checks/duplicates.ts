// BF_SERVER_v846_FRAUD - check 4: the same file (exact copy) or the same picture (perceptual hash within a few bits) on
// an application for a DIFFERENT business. The same business re-applying with its own documents is normal and is
// only mentioned; a void cheque, ID or bank statement turning up under another business is the classic red flag.
import { result, type CheckResult, type Reason } from "../types.js";

export type DuplicateHit = {
  match: "exact" | "near";
  idKind: "id" | "void_cheque" | "bank_statement" | "other";
  otherApplicationId: string;
  sameBusiness: boolean;
  /** The other application is parked as confirmed fraud. */
  otherIsFraud: boolean;
  distance?: number;
};

const NOUN: Record<DuplicateHit["idKind"], string> = { id: "ID", void_cheque: "void cheque", bank_statement: "bank statement", other: "document" };

export function evaluateDuplicates(hits: DuplicateHit[], documentsChecked: number): CheckResult {
  const reasons: Reason[] = [];
  const other = hits.filter((h) => !h.sameBusiness);
  const byApp = new Map<string, DuplicateHit[]>();
  for (const h of other) byApp.set(h.otherApplicationId, [...(byApp.get(h.otherApplicationId) ?? []), h]);
  for (const [, hs] of byApp) {
    const h = hs.sort((a, b) => (a.match === "exact" ? -1 : 1) - (b.match === "exact" ? -1 : 1))[0]!;
    const strong = h.idKind !== "other" || h.otherIsFraud;
    const how = h.match === "exact" ? "The exact same file" : "A near-identical picture";
    reasons.push({
      code: `duplicate_${h.match}_${h.idKind}`,
      severity: strong ? "red" : "amber",
      text: `${how} (${NOUN[h.idKind]}) was uploaded on another application for a different business${h.otherIsFraud ? " that was confirmed as fraud" : ""}.`,
    });
  }
  const same = hits.filter((h) => h.sameBusiness);
  if (same.length) reasons.push({ code: "duplicate_same_business", severity: "info", text: `${same.length} file(s) were also uploaded on an earlier application from the same business (normal for a repeat client).` });
  if (!reasons.length) reasons.push({ code: "no_duplicates", severity: "info", text: `None of the ${documentsChecked} file(s) appear on any other application.` });
  return result(reasons, { documents_checked: documentsChecked, other_business_matches: other.length, other_applications: byApp.size });
}
