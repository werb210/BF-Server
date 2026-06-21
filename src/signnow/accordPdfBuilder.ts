// BF_SERVER_BLOCK_v203_SIGNNOW_ACCORD_GROUP_v1
// Stamps application data onto the real Accord "Revolving Solutions" credit
// application PDF (loaded from blob: SIGNNOW_ACCORD_BLANK_BLOB). Coordinates
// were render-verified against the actual form.
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { dbQuery } from "../db.js";
import { downloadBlobAsset } from "./blobStorage.js";

const PH = 792;
const INK = rgb(0, 0, 0.55);

const BIZ: Record<string, { x: number; y: number }> = {
  legalName: { x: 116.0, y: 95.6 }, dba: { x: 225.3, y: 107.3 }, structure: { x: 110.6, y: 119.1 },
  fiscalYearEnd: { x: 290.5, y: 119.1 }, cra: { x: 488.8, y: 119.1 }, website: { x: 65.3, y: 131.1 },
  since: { x: 492.3, y: 131.1 }, nature: { x: 230.1, y: 142.9 }, bizAddr: { x: 241.8, y: 154.6 },
  mailAddr: { x: 185.8, y: 166.6 }, workPhone: { x: 61.3, y: 178.4 }, primary: { x: 422.3, y: 178.4 },
  annualSales: { x: 171.2, y: 425.1 }, limit: { x: 401.9, y: 425.1 },
  existingBank: { x: 161.1, y: 438.8 }, balanceOut: { x: 369.6, y: 438.8 }, authLimit: { x: 514.2, y: 438.8 },
};
const OWN_X: Record<string, number> = { fullName: 97.9, dob: 349.9, sin: 504.1, addr: 226.4, ownRent: 73.7, propVal: 168.7, mortgage: 272.5, sinceAddr: 381.2, bankrupt: 214.2, bankruptWhen: 416.0, home: 85.8, mobile: 215.2, work: 328.3, ownership: 547, email: 403.1 };
const OWN_Y: Record<string, number> = { fullName: 463.7, addr: 475.5, propRow: 487.3, bankRow: 499.3, phoneRow: 511.0, email: 522.8 };
const OWNER2_DY = 82.6;

function obj(v: unknown): Record<string, any> | null { return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, any>) : null; }
function sv(v: unknown): string { return v === null || v === undefined ? "" : String(v); }
function money(v: unknown): string { if (v === null || v === undefined || v === "") return ""; const n = Number(String(v).replace(/[^0-9.\-]/g, "")); return Number.isFinite(n) ? "$" + Math.round(n).toLocaleString() : sv(v); }

function ownerData(src: Record<string, any>, prefix = "") {
  const g = (k: string) => src[prefix ? prefix + k[0].toUpperCase() + k.slice(1) : k];
  return {
    fullName: [sv(g("firstName")), sv(g("lastName"))].filter(Boolean).join(" "),
    dob: sv(g("dob")), sin: sv(g("ssn")) || sv(g("sin")),
    addr: [sv(g("street")), sv(g("city")), sv(g("state")) || sv(g("province")), sv(g("zip")) || sv(g("postalCode"))].filter(Boolean).join(", "),
    ownRent: sv(g("ownRent")), propVal: money(g("propertyValue")), mortgage: money(g("mortgageBalance")),
    sinceAddr: sv(g("since")) || sv(g("monthsAtAddress")),
    bankrupt: g("bankruptcyFiled") === true || /yes/i.test(sv(g("bankruptcyFiled"))) ? "Yes" : (g("bankruptcyFiled") != null ? "No" : ""),
    bankruptWhen: sv(g("bankruptcyWhen")),
    home: sv(g("homePhone")), mobile: sv(g("phone")) || sv(g("mobilePhone")), work: sv(g("workPhone")),
    ownership: g("ownership") != null ? sv(g("ownership")) : "", email: sv(g("email")),
  };
}

export async function buildAccordPdf(applicationId: string): Promise<Uint8Array> {
  const blobName = (process.env.SIGNNOW_ACCORD_BLANK_BLOB || "accord_revolving_credit_blank.pdf").trim();
  const blank = await downloadBlobAsset(blobName);
  if (!blank) throw new Error(`Accord blank PDF not found in blob: ${blobName}`);

  const res = await dbQuery<{ name: string | null; requested_amount: string | null; metadata: any }>(
    `SELECT name, requested_amount, metadata FROM applications WHERE id::text = ($1)::text LIMIT 1`, [applicationId]);
  const md = obj(res.rows[0]?.metadata) ?? {};
  const business = obj(md.business) ?? {};
  const applicant = obj(md.applicant) ?? {};
  const kyc = obj(md.kyc) ?? obj(md.financial) ?? {};

  const owners = [ownerData(applicant)];
  const nested = obj(applicant.partner) ?? obj(md.partner);
  if (applicant.hasMultipleOwners || applicant.partnerFirstName || nested?.firstName) {
    owners.push(nested ? ownerData(nested) : ownerData(applicant, "partner"));
  }

  const biz: Record<string, string> = {
    legalName: sv(business.legalName) || sv(business.companyName) || sv(res.rows[0]?.name),
    dba: sv(business.businessName) || sv(business.dba),
    structure: sv(business.businessStructure),
    fiscalYearEnd: sv(business.fiscalYearEnd) || sv(kyc.fiscalYearEnd),
    cra: sv(business.craBusinessNumber) || sv(business.businessNumber),
    website: sv(business.website),
    since: sv(business.startDate),
    nature: sv(kyc.industry) || sv(business.industry),
    bizAddr: [sv(business.address) || sv(business.street), sv(business.city), sv(business.state) || sv(business.province), sv(business.zip) || sv(business.postalCode)].filter(Boolean).join(", "),
    mailAddr: sv(business.mailingAddress) || (business.mailingSameAsBusiness ? "Same as above" : ""),
    workPhone: sv(business.phone),
    primary: owners[0]?.fullName ?? "",
    annualSales: money(kyc.annualRevenue) || money(business.estimatedRevenue),
    limit: money(res.rows[0]?.requested_amount) || money(kyc.fundingAmount),
    existingBank: sv(kyc.existingBank), balanceOut: money(kyc.existingBalance), authLimit: money(kyc.existingAuthLimit),
  };

  const doc = await PDFDocument.load(blank);
  const F = await doc.embedFont(StandardFonts.Helvetica);
  const pg = doc.getPage(0);
  const put = (txt: string, x: number, y: number, size = 7.5) => { if (txt) pg.drawText(txt, { x, y: PH - y, size, font: F, color: INK }); };

  for (const [k, v] of Object.entries(biz)) { const p = BIZ[k]; if (p) put(v, p.x, p.y); }
  owners.forEach((o, i) => {
    const dy = i * OWNER2_DY;
    put(o.fullName, OWN_X.fullName, OWN_Y.fullName + dy);
    put(o.dob, OWN_X.dob, OWN_Y.fullName + dy);
    put(o.sin, OWN_X.sin, OWN_Y.fullName + dy);
    put(o.addr, OWN_X.addr, OWN_Y.addr + dy);
    put(o.ownRent, OWN_X.ownRent, OWN_Y.propRow + dy);
    put(o.propVal, OWN_X.propVal, OWN_Y.propRow + dy);
    put(o.mortgage, OWN_X.mortgage, OWN_Y.propRow + dy);
    put(o.sinceAddr, OWN_X.sinceAddr, OWN_Y.propRow + dy);
    put(o.bankrupt, OWN_X.bankrupt, OWN_Y.bankRow + dy);
    put(o.bankruptWhen, OWN_X.bankruptWhen, OWN_Y.bankRow + dy);
    put(o.home, OWN_X.home, OWN_Y.phoneRow + dy);
    put(o.mobile, OWN_X.mobile, OWN_Y.phoneRow + dy);
    put(o.work, OWN_X.work, OWN_Y.phoneRow + dy);
    put(o.ownership, OWN_X.ownership, OWN_Y.phoneRow + dy);
    put(o.email, OWN_X.email, OWN_Y.email + dy);
  });

  // SignNow signature/date field anchors (white = invisible to signer; fieldextract creates the fields)
  const pg3 = doc.getPage(2);
  const tag = (p: typeof pg, txt: string, x: number, y: number) => p.drawText(txt, { x, y: PH - y, size: 6, font: F, color: rgb(1, 1, 1) });
  tag(pg, "{{t:s;r:y;o:\"Owner 1\";w:140;h:18;}}", 40, 684);
  tag(pg, "{{t:s;r:y;o:\"Owner 2\";w:140;h:18;}}", 234, 684);
  tag(pg, "{{t:t;r:y;o:\"Owner 1\";w:70;h:14;}}", 432, 684);
  tag(pg3, "{{t:s;r:y;o:\"Owner 1\";w:140;h:18;}}", 95, 521);
  tag(pg3, "{{t:s;r:y;o:\"Owner 2\";w:140;h:18;}}", 329, 521);

  return doc.save();
}
