// BF_SERVER_v846_FRAUD - check 8: ID checks. The name and date of birth read from the ID (OCR) against the applicant;
// screenshots passed off as ID photos; the same ID picture on another application; and an ID-verification vendor
// when one is set up (none is today - that part reports "not set up").
import { combine, notApplicable, notConfigured, result, type CheckResult, type Reason } from "../types.js";
import { sameName } from "./business.js";

export type IdDoc = {
  documentId: string;
  ocrName: string | null;
  ocrDob: string | null;
  fileType: "jpeg" | "png" | "pdf" | "other";
  width: number | null;
  height: number | null;
  screenSized: boolean;
  hasCameraExif: boolean;
  editorSoftware: string | null;
};

export function normalizeDob(v: string | null | undefined): string | null {
  const s = String(v ?? "").trim();
  if (!s) return null;
  let m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
  if (m) return `${m[1]}-${m[2]!.padStart(2, "0")}-${m[3]!.padStart(2, "0")}`;
  m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/);
  if (m) {
    // Canadian IDs print YYYY-MM-DD or DD-MM-YYYY; US ones MM/DD/YYYY. Only accept unambiguous day > 12 cases.
    const a = Number(m[1]), b = Number(m[2]);
    if (a > 12) return `${m[3]}-${String(b).padStart(2, "0")}-${String(a).padStart(2, "0")}`;
    if (b > 12) return `${m[3]}-${String(a).padStart(2, "0")}-${String(b).padStart(2, "0")}`;
    return null;
  }
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

export function evaluateIdentity(i: {
  idDocs: IdDoc[];
  applicantName: string | null;
  applicantDob: string | null;
  ownerNames: string[];
  reusedElsewhere: number;
  idvConfigured: boolean;
}): CheckResult {
  if (!i.idDocs.length) return notApplicable("No ID document has been uploaded yet.");
  const reasons: Reason[] = [];
  const people = [i.applicantName, ...i.ownerNames].filter((n): n is string => Boolean(n));
  for (const d of i.idDocs) {
    if (d.ocrName && people.length && !people.some((p) => sameName(p, d.ocrName))) {
      reasons.push({ code: "id_name_mismatch", severity: "red", text: `The name on the ID ("${d.ocrName}") does not match the applicant or any owner on the file.` });
    }
    const idDob = normalizeDob(d.ocrDob), appDob = normalizeDob(i.applicantDob);
    if (idDob && appDob && idDob !== appDob && d.ocrName && i.applicantName && sameName(d.ocrName, i.applicantName)) {
      reasons.push({ code: "id_dob_mismatch", severity: "red", text: "The date of birth on the ID does not match the one on the application." });
    }
    if (d.screenSized && !d.hasCameraExif) {
      reasons.push({ code: "id_screenshot", severity: "amber", text: `The ID image is exactly a phone or monitor screen size (${d.width}x${d.height}) with no camera details - it looks like a screenshot, not a photo of the card.` });
    }
    if (d.editorSoftware) reasons.push({ code: "id_edited", severity: "red", text: `The ID image was saved by photo-editing software ("${d.editorSoftware}").` });
  }
  if (i.reusedElsewhere > 0) reasons.push({ code: "id_reused", severity: "red", text: `This ID picture (or a near-identical one) is on ${i.reusedElsewhere} other application(s) for a different business.` });
  if (!reasons.length) {
    const read = i.idDocs.some((d) => d.ocrName);
    reasons.push({ code: "id_ok", severity: "info", text: read ? "The name on the ID matches the applicant, and the image looks like a real photo." : "The ID image looks like a real photo. Its text has not been read, so the name and date of birth were not compared." });
  }
  const own = result(reasons, { id_documents: i.idDocs.length });
  const vendor = i.idvConfigured ? null : notConfigured("Third-party ID verification (liveness, document authenticity) is not set up.", "idv");
  return vendor ? combine([own, vendor]) : own;
}
