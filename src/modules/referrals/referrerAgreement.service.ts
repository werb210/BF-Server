// BF_SERVER_REFERRER_SIGNUP_v1 - SignNow referrer-agreement helper.
// Copies the referrer-agreement template, wraps it in a document group, creates
// an embedded invite for the referrer, and returns an on-page embedded signing
// link. Activation happens via the SignNow webhook (see routes/signnow.ts).
// Env-gated: without SIGNNOW_API_KEY + SIGNNOW_REFERRER_TEMPLATE_ID the flow
// reports "not configured" so the rest of signup still works and staff can
// finish wiring the template later without a code change.
import {
  isApiKeyConfigured,
  createDocumentFromTemplate,
  createDocumentGroup,
  createEmbeddedGroupInvite,
  createEmbeddedGroupLink,
  getDocumentGroupStatus,
  prefillTextFields,
} from "../../signnow/signnowClient.js";

export function referrerAgreementConfigured(): boolean {
  return isApiKeyConfigured() && (process.env.SIGNNOW_REFERRER_TEMPLATE_ID ?? "").trim().length > 0;
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
  const templateId = (process.env.SIGNNOW_REFERRER_TEMPLATE_ID ?? "").trim();
  const roleName = (process.env.SIGNNOW_REFERRER_ROLE_NAME ?? "Referrer").trim();
  if (!referrerAgreementConfigured()) {
    throw new Error("referrer_agreement_not_configured");
  }
  const { documentId } = await createDocumentFromTemplate(
    templateId,
    `Boreal Referral Agreement - ${params.fullName} - ${params.referrerId}`,
  );
  // BF_SERVER_REFERRER_AGREEMENT_PREFILL_v1 - pre-fill the text fields from signup
  // so the referrer only has to sign. Field names match the PDF tag labels.
  // Best-effort: a prefill hiccup must not block signing.
  const today = new Intl.DateTimeFormat("en-US", { year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  const cityLine = [params.city, params.province, params.postal].filter((v) => v && String(v).trim()).join(" ");
  try {
    await prefillTextFields(documentId, [
      { name: "Full name", value: params.fullName },
      { name: "Company", value: params.company },
      { name: "Email", value: params.email },
      { name: "Phone", value: params.phone },
      { name: "Street address", value: params.street },
      { name: "City Province Postal", value: cityLine },
      { name: "Payout email", value: params.etransfer },
      { name: "Date", value: today },
    ]);
  } catch (err) {
    console.warn("[referrer_agreement] prefill failed (non-fatal)", err instanceof Error ? err.message : String(err));
  }
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
