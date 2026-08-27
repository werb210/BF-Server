// BF_SERVER_SBA_OWNERS_v95
import { createHash } from "node:crypto";
import { dbQuery } from "../../db.js";

export type SbaOwner = {
  index: number;
  firstName: string; lastName: string; fullName: string; email: string; title: string;
  ownershipPercent: number; ssn: string; dob: string; homeAddress: string; homePhone: string;
  placeOfBirth: string; usCitizen: string; alienRegistrationNumber: string;
  formerNames: string; priorAddress: string; q8: string; q9: string; q10: string;
  // BF_SERVER_SBA_FIELD_GAPS_v134 - the parts, kept alongside the joined string.
  // Forms ask for them separately and a joined string cannot be split back
  // reliably once a city contains a comma.
  homeStreet: string; homeCityStateZip: string; addressSince: string;
  veteranStatus: string; sex: string; race: string; ethnicity: string;
};

const s = (v: unknown) => String(v ?? "").trim();
const pct = (v: unknown) => {
  const n = Number(s(v).replace(/[^0-9.]/g, ""));
  return Number.isFinite(n) ? n : 0;
};

function shape(raw: any, index: number): SbaOwner {
  const firstName = s(raw?.firstName), lastName = s(raw?.lastName);
  return {
    index, firstName, lastName, fullName: [firstName, lastName].filter(Boolean).join(" "),
    email: s(raw?.email), title: s(raw?.title), ownershipPercent: pct(raw?.ownership),
    ssn: s(raw?.ssn), dob: s(raw?.dob),
    homeAddress: [s(raw?.street), s(raw?.city), s(raw?.state), s(raw?.zip)].filter(Boolean).join(", "),
    homeStreet: s(raw?.street),
    homeCityStateZip: [s(raw?.city), s(raw?.state), s(raw?.zip)].filter(Boolean).join(", "),
    addressSince: s(raw?.addressSince),
    homePhone: s(raw?.homePhone) || s(raw?.phone), placeOfBirth: s(raw?.placeOfBirth),
    usCitizen: s(raw?.usCitizen), alienRegistrationNumber: s(raw?.alienRegistrationNumber),
    formerNames: s(raw?.formerNames), priorAddress: s(raw?.priorAddress),
    q8: s(raw?.sba912Q8), q9: s(raw?.sba912Q9), q10: s(raw?.sba912Q10),
    veteranStatus: s(raw?.veteranStatus), sex: s(raw?.sex), race: s(raw?.race), ethnicity: s(raw?.ethnicity),
  };
}

// BF_SERVER_SBA_OWNER_IDENTITY_v104
// Identity of an owner, independent of their position in the array. Email is the
// stronger signal - it is what SignNow addresses and what the mini-portal logs in
// with - and name is the fallback for an owner recorded without one. Whitespace
// and case are normalised so a cosmetic edit does not read as a different person.
export function ownerFingerprint(owner: { fullName?: string; email?: string }): string {
  const email = String(owner?.email ?? "").trim().toLowerCase();
  const name = String(owner?.fullName ?? "").trim().toLowerCase().replace(/\s+/g, " ");
  const basis = email || name;
  if (!basis) return "";
  return createHash("sha1").update(basis).digest("hex").slice(0, 16);
}

/** Resolve every owner at or above the SBA threshold, retaining unstated percentages. */
export async function resolveSbaOwners(applicationId: string, threshold = 20): Promise<SbaOwner[]> {
  const result = await dbQuery<{ metadata: any }>(
    `SELECT metadata FROM applications WHERE id::text = ($1)::text LIMIT 1`, [applicationId],
  ).catch(() => ({ rows: [] as Array<{ metadata: any }> }));
  const applicant = result.rows[0]?.metadata?.applicant ?? {};
  const raw: any[] = [applicant];
  if (applicant?.hasMultipleOwners && applicant?.partner) raw.push(applicant.partner);
  if (Array.isArray(applicant?.additionalShareholders)) raw.push(...applicant.additionalShareholders);
  return raw.map(shape)
    .filter((owner) => owner.fullName || owner.email)
    .filter((owner) => owner.ownershipPercent === 0 || owner.ownershipPercent >= threshold)
    .map((owner, index) => ({ ...owner, index: index + 1 }));
}

export async function loadSbaContext(applicationId: string): Promise<{
  meta: any; business: any; kyc: any; form1919: any; form413ByOwner: Map<string, any>;
}> {
  const application = await dbQuery<{ metadata: any }>(
    `SELECT metadata FROM applications WHERE id::text = ($1)::text LIMIT 1`, [applicationId],
  ).catch(() => ({ rows: [] as Array<{ metadata: any }> }));
  const meta = application.rows[0]?.metadata ?? {};
  const forms = await dbQuery<{ doc_type: string; data: any }>(
    `SELECT doc_type, data FROM application_form_responses
      WHERE application_id::text = ($1)::text AND submitted_at IS NOT NULL`, [applicationId],
  ).catch(() => ({ rows: [] as Array<{ doc_type: string; data: any }> }));
  let form1919: any = {};
  const form413ByOwner = new Map<string, any>();
  for (const row of forms.rows) {
    const type = String(row.doc_type);
    if (type === "sba_form_1919") form1919 = row.data?.fields ?? row.data ?? {};
    else if (type.startsWith("sba_form_413")) {
      const suffix = type === "sba_form_413" ? "1" : type.replace("sba_form_413_owner_", "");
      form413ByOwner.set(suffix, row.data?.fields ?? row.data ?? {});
    }
  }
  return { meta, business: meta?.business ?? {}, kyc: meta?.kyc ?? {}, form1919, form413ByOwner };
}
