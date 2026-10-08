// BF_SERVER_MAYA_SEES_PORTAL_v782 - ONE place that decides where an application's details live in metadata. The
// staff portal's Application tab and client Maya both read through this, so Maya knows exactly what staff see.
// Files saved by different generations of the wizard keep the same answers under different keys (applicant /
// borrower / formData.applicant, company / business, kyc / borrower / financialProfile, readiness drafts).
export type ApplicationProfile = {
  kyc: Record<string, any> | null;
  applicant: Record<string, any> | null;
  business: Record<string, any> | null;
  owners: any[];
  financialProfile: Record<string, any> | null;
  productCategory: string | null;
  submittedAt: string | null;
};

const obj = (v: unknown): Record<string, any> | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, any>) : null);

export function applicationProfileFromMetadata(metadata: unknown): ApplicationProfile {
  const md = obj(metadata) ?? {};
  const fd = obj(md.formData) ?? {};
  const readiness = obj(md.readiness);
  return {
    kyc: obj(md.borrower) ?? obj(md.kyc_responses) ?? obj(md.kyc) ?? obj(fd.kyc) ?? obj(fd.financialProfile) ?? readiness,
    applicant: obj(md.applicant) ?? obj(md.borrower) ?? obj(fd.applicant) ?? readiness,
    business: obj(md.company) ?? obj(md.business) ?? obj(fd.business) ?? readiness,
    owners: Array.isArray(md.owners) ? md.owners
      : md.partner ? [md.partner]
      : obj(md.applicant)?.partner ? [md.applicant.partner]
      : obj(fd.applicant)?.partner ? [fd.applicant.partner]
      : [],
    financialProfile: obj(md.financials) ?? obj(md.kyc) ?? obj(fd.kyc) ?? obj(fd.financialProfile) ?? readiness,
    productCategory: md.application?.productCategory ?? md.product_category ?? fd.productCategory ?? fd.product_category ?? null,
    submittedAt: md.submittedAt ?? null,
  };
}

// For client Maya: every place an answer could be saved, combined (the newest-style record wins a conflict), so she
// sees the fullest picture rather than only the first record found.
export function mergedProfileFromMetadata(metadata: unknown): { applicant: Record<string, any>; business: Record<string, any>; financial: Record<string, any> } {
  const md = obj(metadata) ?? {};
  const fd = obj(md.formData) ?? {};
  const r = obj(md.readiness) ?? {};
  const pick = (...parts: Array<Record<string, any> | null>) => Object.assign({}, ...parts.filter(Boolean));
  return {
    applicant: pick(r, obj(fd.applicant), obj(md.borrower), obj(md.applicant)),
    business: pick(r, obj(fd.business), obj(md.business), obj(md.company)),
    financial: pick(r, obj(fd.financialProfile), obj(fd.kyc), obj(md.financials), obj(md.kyc), obj(md.kyc_responses), obj(md.borrower)),
  };
}
