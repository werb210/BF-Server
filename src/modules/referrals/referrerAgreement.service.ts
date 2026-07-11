// BF_SERVER_REFERRER_SIGNUP_v1 - SignNow referrer-agreement helper.
// Generates a per-referrer agreement PDF, uploads it with field extraction,
// wraps it in a document group, creates an embedded invite for the referrer,
// and returns an on-page embedded signing link. Activation happens via the
// SignNow webhook (see routes/signnow.ts).
// Env-gated: without SIGNNOW_API_KEY the flow reports "not configured" so the
// rest of signup still works while SignNow is not configured.
import { buildReferrerAgreementPdf } from "../../signnow/referrerAgreementPdfBuilder.js";
import {
  isApiKeyConfigured,
  uploadDocumentWithFieldExtract,
  createDocumentGroup,
  createEmbeddedGroupInvite,
  createEmbeddedGroupLink,
  getDocumentGroupStatus,
} from "../../signnow/signnowClient.js";

export function referrerAgreementConfigured(): boolean {
  // BF_SERVER_REFERRER_AGREEMENT_BAKE_v1 - agreement generated per-referrer with details
  // baked in; no shared template used, so only the API key is required.
  return isApiKeyConfigured();
}

export type ReferrerAgreementSession = {
  documentId: string;
  groupId: string;
  inviteId: string;
  url: string;
};

export async function createReferrerAgreementSession(params: {
  referrerId: string;
  fullName: string;
  email: string;
  // BF_SERVER_REFERRER_AGREEMENT_PREFILL_v1 - optional profile data to pre-fill.
  company?: string | null;
  phone?: string | null;
  street?: string | null;
  city?: string | null;
  province?: string | null;
  postal?: string | null;
  etransfer?: string | null;
}): Promise<ReferrerAgreementSession> {
  const roleName = (process.env.SIGNNOW_REFERRER_ROLE_NAME ?? "Referrer").trim();
  if (!referrerAgreementConfigured()) {
    throw new Error("referrer_agreement_not_configured");
  }
  // BF_SERVER_REFERRER_AGREEMENT_BAKE_v1 - generate the agreement with the referrer's
  // details already printed in and upload it directly (no template, no prefill); the
  // only thing the referrer completes is the signature.
  const cityLine = [params.city, params.province, params.postal].filter((v) => v && String(v).trim()).join(" ");
  const pdf = await buildReferrerAgreementPdf({
    fullName: params.fullName,
    company: params.company ?? null,
    email: params.email,
    phone: params.phone ?? null,
    street: params.street ?? null,
    cityProvincePostal: cityLine,
    payoutEmail: params.etransfer ?? null,
  });
  const { documentId } = await uploadDocumentWithFieldExtract(
    pdf,
    `Boreal Referral Agreement - ${params.fullName} - ${params.referrerId}.pdf`,
  );
  const { groupId } = await createDocumentGroup([documentId], `Referral Agreement ${params.referrerId}`);
  const { inviteId } = await createEmbeddedGroupInvite(groupId, [documentId], [
    { email: params.email, name: params.fullName, roleName },
  ]);
  const { url } = await createEmbeddedGroupLink(groupId, inviteId, params.email);
  return { documentId, groupId, inviteId, url };
}

export async function isReferrerAgreementSigned(groupId: string): Promise<boolean> {
  try {
    const status = await getDocumentGroupStatus(groupId);
    return status.signed;
  } catch {
    return false;
  }
}
