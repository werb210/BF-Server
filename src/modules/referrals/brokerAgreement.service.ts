// BF_SERVER_BROKER_PORTAL_v717 - SignNow session for the general Broker Co-Brokerage
// and Fee-Sharing Agreement (same steps as the referrer agreement).
import { buildBrokerAgreementPdf } from "../../signnow/brokerAgreementPdfBuilder.js";
import { uploadDocumentWithFieldExtract, createDocumentGroup, createEmbeddedGroupInvite, createEmbeddedGroupLink } from "../../signnow/signnowClient.js";

export async function createBrokerAgreementSession(p: { brokerId: string; fullName: string; email: string; company: string | null; phone: string | null; street: string | null; city: string | null; province: string | null; postal: string | null }) {
  const roleName = (process.env.SIGNNOW_REFERRER_ROLE_NAME ?? "Referrer").trim();
  const cityLine = [p.city, p.province, p.postal].filter((v) => v && String(v).trim()).join(" ");
  const pdf = await buildBrokerAgreementPdf({ fullName: p.fullName, company: p.company, email: p.email, phone: p.phone, street: p.street, cityProvincePostal: cityLine });
  const { documentId } = await uploadDocumentWithFieldExtract(pdf, `Boreal Broker Agreement - ${p.company ?? p.fullName} - ${p.brokerId}.pdf`);
  const { groupId } = await createDocumentGroup([documentId], `Broker Agreement ${p.brokerId}`);
  const { inviteId } = await createEmbeddedGroupInvite(groupId, [documentId], [{ email: p.email, name: p.fullName, roleName }]);
  const { url } = await createEmbeddedGroupLink(groupId, inviteId, p.email);
  return { documentId, groupId, inviteId, url };
}
