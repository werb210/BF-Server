// BF_SERVER_BLOCK_v203_SIGNNOW_ACCORD_GROUP_v1
// + BF_SERVER_BLOCK_v_ACCORD_FULL_FILL_v1 — complete Accord "Revolving Solutions"
// fill across all 3 pages. Every coordinate render-verified against the blank.
// Data sources: applications.metadata (.business/.applicant/.kyc, raw camelCase)
// and application_form_responses (doc_type='professional_advisors').
// NOTE: blank template is pre-cleaned (##-#/0 placeholders removed); no runtime masking.
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
const OWN_X: Record<string, number> = { fullName: 97.9, dob: 349.9, sin: 504.1, addr: 226.4, propVal: 168.7, mortgage: 272.5, sinceAddr: 381.2, bankruptWhen: 416.0, home: 85.8, mobile: 215.2, work: 328.3, ownership: 547, email: 403.1 };
const OWN_Y: Record<string, number> = { fullName: 463.7, addr: 475.5, propRow: 487.3, bankRow: 499.3, phoneRow: 511.0, email: 522.8 };
const OWNER2_DY = 82.6;

// v_ACCORD_FULL_FILL_v1 — page-1 risk answers (right column)
const RISK_X = 548;
const RISK_Y = [205.7, 217.5, 229.5, 246.0, 262.0];
// page-1 checkbox tick centres (shareholder #1; +OWNER2_DY for #2)
const CB = { own: { x: 33, y: 477.6 }, rent: { x: 75, y: 477.6 }, bkYes: { x: 222, y: 489.6 }, bkNo: { x: 262, y: 489.6 } };
// page-1 professional-advisors grid
const ADV_COL = { firm: 142, contact: 255, phone: 345, email: 448 };
const ADV_ROW: Record<string, number> = { cpa: 361.4, attorney: 371.7, insurance: 382.0, ar_credit_insurance: 392.4 };
// page-2 layout
const P2_CLIENT = [{ x: 74, y: 564.7 }];  // v_ACCORD_FIX: dropped y:75.3 (overlapped 'PAGE 2 of 3' header)
const P3_CLIENT = { x: 121, y: 77.7 };
const OWNTBL = { name: 60, addr: 176, contact: 313, own: 404, dir: 458, off: 508, yName: 156, yOff: 156.5, yMob: 166.4, yEmail: 176.2, yOwn: 166.1, rowDY: 30 };
const OWNADDL = { yName: 234, yOff: 232.8, yMob: 242.7, yEmail: 252.5, rowDY: 30 };
const SRL = { name: 62, title: 190, contact: 327, dir: 458, off: 508, yName: 355, yOff: 351.4, yMob: 361.2, yEmail: 371.1, rowDY: 30 };
const MON: Record<string, { x: number; y: number }> = { acctSoftware: { x: 150, y: 606.7 }, acctRemote: { x: 485, y: 606.7 }, primaryBank: { x: 150, y: 623 }, bankRemote: { x: 485, y: 623 }, craMyBiz: { x: 278, y: 639.4 } };

function obj(v: unknown): Record<string, any> | null { return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, any>) : null; }
function sv(v: unknown): string { return v === null || v === undefined ? "" : String(v); }
function money(v: unknown): string { if (v === null || v === undefined || v === "") return ""; const n = Number(String(v).replace(/[^0-9.\-]/g, "")); return Number.isFinite(n) ? "$" + Math.round(n).toLocaleString() : sv(v); }
function yesno(v: unknown): string { if (v === true) return "Yes"; if (v === false) return "No"; const s = sv(v).trim(); if (!s) return ""; if (/^(y|yes|true)$/i.test(s)) return "Yes"; if (/^(n|no|false)$/i.test(s)) return "No"; return s; }

function ownerData(src: Record<string, any>, prefix = "") {
  const g = (k: string) => src[prefix ? prefix + k[0].toUpperCase() + k.slice(1) : k];
  return {
    fullName: [sv(g("firstName")), sv(g("lastName"))].filter(Boolean).join(" "),
    dob: sv(g("dob")), sin: sv(g("ssn")) || sv(g("sin")),
    addr: [sv(g("street")), sv(g("city")), sv(g("state")) || sv(g("province")), sv(g("zip")) || sv(g("postalCode"))].filter(Boolean).join(", "),
    ownRent: sv(g("ownRent")), propVal: money(g("propertyValue")), mortgage: money(g("mortgageBalance")),
    sinceAddr: sv(g("addressSince")) || sv(g("since")) || sv(g("monthsAtAddress")),
    bankrupt: yesno(g("bankruptcyFiled")), bankruptWhen: sv(g("bankruptcyWhen")),
    home: sv(g("homePhone")), mobile: sv(g("phone")) || sv(g("mobilePhone")),
    ownership: sv(g("ownership")).replace(/%$/, ""),
    email: sv(g("email")), title: sv(g("title")), director: yesno(g("director")), officer: yesno(g("officer")),
  };
}
type Owner = ReturnType<typeof ownerData>;

export async function buildAccordPdf(applicationId: string): Promise<Uint8Array> {
  const blobName = (process.env.SIGNNOW_ACCORD_BLANK_BLOB || "accord_revolving_credit_blank.pdf").trim();
  const blank = await downloadBlobAsset(blobName);
  if (!blank) throw new Error(`Accord blank PDF not found in blob: ${blobName}`);

  const res = await dbQuery<{ name: string | null; requested_amount: string | null; metadata: any }>(
    `SELECT name, requested_amount, metadata FROM applications WHERE id::text = ($1)::text LIMIT 1`, [applicationId]);
  const md = obj(res.rows[0]?.metadata) ?? {};
  const business = obj(md.business) ?? {};
  const company = obj(md.company) ?? {};
  const applicant = obj(md.applicant) ?? {};
  const kyc = obj(md.kyc) ?? obj(md.financial) ?? {};

  // v_ACCORD_FULL_FILL_v1 — professional advisors + ongoing monitoring + existing-bank trio
  const adv = await dbQuery<{ data: any }>(
    `SELECT data FROM application_form_responses WHERE application_id::text = ($1)::text AND doc_type = 'professional_advisors' LIMIT 1`, [applicationId]
  ).catch(() => ({ rows: [] as { data: any }[] }));
  const advData = obj(adv.rows[0]?.data) ?? {};
  const advisors = obj(advData.advisors) ?? {};
  const monitoring = obj(advData.monitoring) ?? {};
  const advAuth = !!(obj(advData.financial_advisor)?.authorized);

  // owners: #1 = applicant, #2 = applicant.partner, 3+ = additionalShareholders
  const owners: Owner[] = [ownerData(applicant)];
  const partner = obj(applicant.partner) ?? obj(md.partner);
  if (applicant.hasMultipleOwners || partner?.firstName) { if (partner) owners.push(ownerData(partner)); }
  const additional: Owner[] = (Array.isArray(applicant.additionalShareholders) ? applicant.additionalShareholders : [])
    .map((r: any) => ({ fullName: sv(r?.name), addr: sv(r?.address), home: "", mobile: sv(r?.mobile), email: sv(r?.email),
      ownership: sv(r?.ownership).replace(/%$/, ""), director: yesno(r?.director), officer: yesno(r?.officer),
      title: sv(r?.title), dob: "", sin: "", ownRent: "", propVal: "", mortgage: "", sinceAddr: "", bankrupt: "", bankruptWhen: "", office: sv(r?.office) } as any));

  const bizPhone = sv(business.phone);
  const biz: Record<string, string> = {
    legalName: sv(business.legalName) || sv(business.companyName) || sv(res.rows[0]?.name),
    dba: sv(business.businessName) || sv(business.dba),
    structure: sv(business.businessStructure),
    fiscalYearEnd: sv(business.fiscalYearEnd) || sv(kyc.fiscalYearEnd),
    cra: sv(business.craBusinessNumber) || sv(business.businessNumber),
    website: sv(business.website), since: sv(business.startDate),
    nature: sv(kyc.industry) || sv(business.industry),
    bizAddr: [sv(business.address) || sv(business.street), sv(business.city), sv(business.state) || sv(business.province), sv(business.zip) || sv(business.postalCode)].filter(Boolean).join(", "),
    mailAddr: sv(business.mailingAddress) || [sv(business.mailingCity), sv(business.mailingState), sv(business.mailingZip)].filter(Boolean).join(", ") || (business.mailingSameAsBusiness ? "Same as above" : ""),
    workPhone: bizPhone, primary: owners[0]?.fullName ?? "",
    annualSales: money(business.estimatedRevenue) || money(kyc.annualRevenue),
    limit: money(res.rows[0]?.requested_amount) || money(kyc.fundingAmount),
    existingBank: sv(monitoring.primaryBank) || sv(kyc.existingBank),
    balanceOut: money(monitoring.balanceOutstanding), authLimit: money(monitoring.authorizedLimit),
  };

  const risk = [
    yesno(business.riskMultipleLocations ?? company.riskMultipleLocations),
    yesno(business.riskBusinessBankruptcy ?? company.riskBusinessBankruptcy),
    yesno(business.riskOwnerBankruptcyPersonal ?? company.riskOwnerBankruptcyPersonal),
    yesno(business.riskOwnerBankruptcyOtherBiz ?? company.riskOwnerBankruptcyOtherBiz),
    yesno(business.riskGovtArrears ?? company.riskGovtArrears),
  ];

  const doc = await PDFDocument.load(blank);
  const F = await doc.embedFont(StandardFonts.Helvetica);
  const FB = await doc.embedFont(StandardFonts.HelveticaBold);
  const p1 = doc.getPage(0), p2 = doc.getPage(1), p3 = doc.getPage(2);
  const put = (pg: any, txt: string, x: number, y: number, size = 7.5) => { if (txt) pg.drawText(txt, { x, y: PH - y, size, font: F, color: INK }); };
  // v_ACCORD_OWN_ALIGN_v1 — right-align ownership numbers so they sit just left of the
  // form's pre-printed "%" (a left-anchored "100" overran the % glyph).
  const putR = (pg: any, txt: string, rightX: number, y: number, size = 7.5) => { if (txt) pg.drawText(txt, { x: rightX - F.widthOfTextAtSize(txt, size), y: PH - y, size, font: F, color: INK }); };
  const tick = (pg: any, x: number, y: number) => pg.drawText("X", { x, y: PH - (y + 8), size: 9, font: FB, color: INK });
  // v_ACCORD_FIX: wrap long values within a column width (used for page-2 owner addresses
  // that previously overflowed into the OFFICE#/contact column).
  const putWrap = (pg: any, txt: string, x: number, y: number, maxWidth: number, size = 6.5, lineGap = 8.5, maxLines = 2) => {
    if (!txt) return;
    const words = txt.split(/\s+/);
    const lines: string[] = [];
    let cur = "";
    for (const w of words) {
      const trial = cur ? cur + " " + w : w;
      if (cur && F.widthOfTextAtSize(trial, size) > maxWidth) { lines.push(cur); cur = w; }
      else cur = trial;
    }
    if (cur) lines.push(cur);
    lines.slice(0, maxLines).forEach((ln, i) => put(pg, ln, x, y + i * lineGap, size));
  };

  // ── PAGE 1 ──
  for (const [k, v] of Object.entries(biz)) { const p = BIZ[k]; if (p) put(p1, v, p.x, p.y); }
  risk.forEach((v, i) => put(p1, v, RISK_X, RISK_Y[i] + 8, 8));
  // professional advisors grid
  for (const key of ["cpa", "attorney", "insurance", "ar_credit_insurance"]) {
    const row = obj(advisors[key]) ?? {}; const y = ADV_ROW[key] + 7;
    put(p1, sv(row.firm), ADV_COL.firm, y, 7); put(p1, sv(row.contact), ADV_COL.contact, y, 7);
    put(p1, sv(row.phone), ADV_COL.phone, y, 7); put(p1, sv(row.email), ADV_COL.email, y, 6.5);
  }
  // shareholders #1/#2 (page 1) — text fields + checkbox ticks
  owners.slice(0, 2).forEach((o, i) => {
    const dy = i * OWNER2_DY;
    put(p1, o.fullName, OWN_X.fullName, OWN_Y.fullName + dy); put(p1, o.dob, OWN_X.dob, OWN_Y.fullName + dy);
    put(p1, o.sin, OWN_X.sin, OWN_Y.fullName + dy); put(p1, o.addr, OWN_X.addr, OWN_Y.addr + dy);
    put(p1, o.propVal, OWN_X.propVal, OWN_Y.propRow + dy); put(p1, o.mortgage, OWN_X.mortgage, OWN_Y.propRow + dy);
    put(p1, o.sinceAddr, OWN_X.sinceAddr, OWN_Y.propRow + dy); put(p1, o.bankruptWhen, OWN_X.bankruptWhen, OWN_Y.bankRow + dy);
    put(p1, o.home, OWN_X.home, OWN_Y.phoneRow + dy); put(p1, o.mobile, OWN_X.mobile, OWN_Y.phoneRow + dy);
    put(p1, bizPhone, OWN_X.work, OWN_Y.phoneRow + dy); putR(p1, o.ownership, 551.5, OWN_Y.phoneRow + dy);
    put(p1, o.email, OWN_X.email, OWN_Y.email + dy);
    if (/own/i.test(o.ownRent)) tick(p1, CB.own.x, CB.own.y + dy); else if (/rent/i.test(o.ownRent)) tick(p1, CB.rent.x, CB.rent.y + dy);
    if (o.bankrupt === "Yes") tick(p1, CB.bkYes.x, CB.bkYes.y + dy); else if (o.bankrupt === "No") tick(p1, CB.bkNo.x, CB.bkNo.y + dy);
  });

  // ── PAGE 2 ──
  P2_CLIENT.forEach((c) => put(p2, biz.dba || biz.legalName, c.x, c.y + 8));
  const ownContact = (pg: any, x: number, o: Owner, yOff: number, yMob: number, yEmail: number) => {
    put(pg, sv((o as any).office) || "", x, yOff); put(pg, o.mobile, x, yMob); put(pg, o.email, x, yEmail, 5.5);
  };
  // ownership table: owner1/owner2 in the two auto rows (mask the ##-#/0% placeholders)
  owners.slice(0, 2).forEach((o, i) => {
    const dy = i * OWNTBL.rowDY;
    put(p2, o.fullName, OWNTBL.name, OWNTBL.yName + dy, 6.5); putWrap(p2, o.addr, OWNTBL.addr, OWNTBL.yName + dy, 132, 6.5);
    ownContact(p2, OWNTBL.contact, o, OWNTBL.yOff + dy, OWNTBL.yMob + dy, OWNTBL.yEmail + dy);
    putR(p2, o.ownership, 414.5, OWNTBL.yOwn + dy, 6.5); put(p2, o.director, OWNTBL.dir, OWNTBL.yName + dy, 6.5); put(p2, o.officer, OWNTBL.off, OWNTBL.yName + dy, 6.5);
  });
  // additional shareholders (rows 3+)
  additional.slice(0, 2).forEach((o, i) => {
    const dy = i * OWNADDL.rowDY;
    put(p2, o.fullName, OWNTBL.name, OWNADDL.yName + dy, 6.5); putWrap(p2, o.addr, OWNTBL.addr, OWNADDL.yName + dy, 132, 6.5);
    ownContact(p2, OWNTBL.contact, o, OWNADDL.yOff + dy, OWNADDL.yMob + dy, OWNADDL.yEmail + dy);
    putR(p2, o.ownership, 418.5, OWNADDL.yMob + dy, 6.5); put(p2, o.director, OWNTBL.dir, OWNADDL.yName + dy, 6.5); put(p2, o.officer, OWNTBL.off, OWNADDL.yName + dy, 6.5);
  });
  // senior leadership: ALL owners
  const everyone = [...owners, ...additional].slice(0, 4);
  everyone.forEach((o, i) => {
    const dy = i * SRL.rowDY;
    put(p2, o.fullName, SRL.name, SRL.yName + dy, 6.5); put(p2, o.title, SRL.title, SRL.yName + dy, 6.5);
    ownContact(p2, SRL.contact, o, SRL.yOff + dy, SRL.yMob + dy, SRL.yEmail + dy);
    put(p2, o.director, SRL.dir, SRL.yName + dy, 6.5); put(p2, o.officer, SRL.off, SRL.yName + dy, 6.5);
  });
  // ongoing monitoring
  put(p2, sv(monitoring.accountingSoftware), MON.acctSoftware.x, MON.acctSoftware.y, 7);
  put(p2, yesno(monitoring.accountingRemoteView), MON.acctRemote.x, MON.acctRemote.y, 7);
  put(p2, sv(monitoring.primaryBank), MON.primaryBank.x, MON.primaryBank.y, 7);
  put(p2, yesno(monitoring.bankRemoteView), MON.bankRemote.x, MON.bankRemote.y, 7);
  put(p2, yesno(monitoring.craMyBusiness), MON.craMyBiz.x, MON.craMyBiz.y, 7);

  // ── PAGE 3 ──
  put(p3, biz.dba || biz.legalName, P3_CLIENT.x, P3_CLIENT.y + 10);

  // SignNow signature/date anchors (white = invisible; fieldextract creates the fields)
  const tag = (pg: any, txt: string, x: number, y: number) => pg.drawText(txt, { x, y: PH - y, size: 6, font: F, color: rgb(1, 1, 1) });
  tag(p1, '{{t:s;r:y;o:"Owner 1";w:140;h:18;}}', 40, 684);
  if (owners[1]?.email) tag(p1, '{{t:s;r:y;o:"Owner 2";w:140;h:18;}}', 234, 684);
  // v_SIGNNOW_DATE_STAMP: no SignNow date field (account rejects auto-date). The real
  // signing date is stamped post-completion at native coords (page 0, x=440, y=108).
  tag(p3, '{{t:s;r:y;o:"Owner 1";w:140;h:18;}}', 95, 521);
  if (owners[1]?.email) tag(p3, '{{t:s;r:y;o:"Owner 2";w:140;h:18;}}', 329, 521);

  void advAuth;
  return doc.save();
}
