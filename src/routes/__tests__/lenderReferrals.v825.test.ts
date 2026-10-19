// BF_SERVER_v825_LENDER_REFERRALS - lenders send their declined files; nothing reaches the client until staff accept.
import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";
import { answerBySql, callsMatching } from "../../__tests__/helpers/answerBySql.js";

const h = vi.hoisted(() => ({ query: vi.fn(), notify: vi.fn(async () => undefined) }));
vi.mock("../../db.js", async (orig) => ({ ...(await orig() as any), pool: { query: h.query, connect: vi.fn() }, runQuery: h.query, dbQuery: h.query }));
vi.mock("../../services/notifications/notifyAllStaff.js", () => ({ notifyAllStaff: h.notify }));

import lenderReferrals from "../lenderReferrals.js";
import {
  acceptReferral,
  clientInviteText,
  declineReferral,
  importReferral,
  parseReferralDetails,
  referralProgress,
  referralShare,
} from "../../services/lenderReferrals/lenderReferrals.js";

const LENDER_ID = "71717171-7171-4171-8171-717171717171";
const lenderAuth = "Bearer " + jwt.sign({ sub: "lender:" + LENDER_ID, role: "Lender", lenderId: LENDER_ID }, process.env.JWT_SECRET as string);

function makeZip(files: Array<{ name: string; data: string }>): Buffer {
  const locals: Buffer[] = []; const centrals: Buffer[] = []; let offset = 0;
  for (const f of files) {
    const name = Buffer.from(f.name); const body = Buffer.from(f.data); const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x800, 6); lh.writeUInt32LE(body.length, 18); lh.writeUInt32LE(body.length, 22); lh.writeUInt16LE(name.length, 26);
    const ch = Buffer.alloc(46); ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0x800, 8); ch.writeUInt32LE(body.length, 20); ch.writeUInt32LE(body.length, 24); ch.writeUInt16LE(name.length, 28); ch.writeUInt32LE(offset, 42);
    locals.push(lh, name, body); centrals.push(ch, name); offset += 30 + name.length + body.length;
  }
  const cd = Buffer.concat(centrals); const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

function app() {
  const a = express();
  a.use(express.json());
  a.use("/api/lender-referrals", lenderReferrals);
  return a;
}

const good = { business_name: "Northwind Logistics", client_name: "Jane Smith", client_phone: "(780) 555-0100", requested_amount: "$250,000", consent: true };

beforeEach(() => {
  h.query.mockReset();
  h.notify.mockClear();
  h.query.mockImplementation(answerBySql([
    [/SELECT name FROM lenders/, { rows: [{ name: "Prairie Bank" }] }],
    [/SELECT id FROM lender_referrals/, { rows: [] }],
    [/INSERT INTO lender_referrals/, (_s: string, p?: unknown[]) => ({ rows: [{ id: "ref-" + String(p?.[5]).slice(-4) }] })],
  ]));
});

describe("details a lender sends with each file", () => {
  it("needs a business name, the client's cell and their consent", () => {
    expect(parseReferralDetails(good)).toEqual({ businessName: "Northwind Logistics", clientName: "Jane Smith", clientPhone: "+17805550100", requestedAmount: 250000, declineReason: null });
    expect(() => parseReferralDetails({ ...good, business_name: " " })).toThrow("business name");
    expect(() => parseReferralDetails({ ...good, client_phone: "555" })).toThrow("cell number");
    expect(() => parseReferralDetails({ ...good, consent: false })).toThrow("agreed to be referred");
    expect(() => parseReferralDetails({ ...good, requested_amount: "lots" })).toThrow("amount");
  });
});

describe("what the lender sees", () => {
  it("shows status only", () => {
    expect(referralProgress({ status: "pending" })).toBe("Under review");
    expect(referralProgress({ status: "declined" })).toBe("Not accepted");
    expect(referralProgress({ status: "accepted", pipeline_state: "draft" })).toBe("Accepted - waiting for the client");
    expect(referralProgress({ status: "accepted", pipeline_state: null })).toBe("Client signed in - in progress");
    expect(referralProgress({ status: "accepted", pipeline_state: "Off to Lender" })).toBe("Submitted to lenders");
    expect(referralProgress({ status: "accepted", pipeline_state: "offer" })).toBe("Approved");
    expect(referralProgress({ status: "accepted", pipeline_state: "funded" })).toBe("Funded");
    expect(referralProgress({ status: "accepted", pipeline_state: "declined" })).toBe("Closed");
    expect(referralShare({ status: "accepted", complete_package: true })).toBe("50% of Boreal's fee");
    expect(referralShare({ status: "accepted", complete_package: false })).toBe("None (incomplete package)");
    expect(referralShare({ status: "pending", complete_package: null })).toBe("-");
  });

  it("never names the lender in the client's text", () => {
    const t = clientInviteText("Jane", "https://client.boreal.financial");
    expect(t).toBe("Hi Jane, Boreal Financial has your business financing application ready. To check it and finish, sign in with this mobile number at https://client.boreal.financial");
  });
});

describe("POST /api/lender-referrals/mine", () => {
  it("takes several zips at once, one referral each, and tells staff", async () => {
    const res = await request(app())
      .post("/api/lender-referrals/mine")
      .set("Authorization", lenderAuth)
      .field("details", JSON.stringify([good, { ...good, business_name: "Contoso Ltd", client_phone: "4035550142" }]))
      .attach("files", makeZip([{ name: "statements.pdf", data: "%PDF" }]), "northwind.zip")
      .attach("files", makeZip([{ name: "application.pdf", data: "%PDF" }]), "contoso.zip");
    expect(res.status).toBe(201);
    expect(res.body.sent).toBe(2);
    expect(res.body.results.map((r: any) => r.ok)).toEqual([true, true]);
    const inserts = callsMatching(h.query, /INSERT INTO lender_referrals/);
    expect(inserts).toHaveLength(2);
    expect(inserts[0]![1]).toEqual(expect.arrayContaining([LENDER_ID, "Prairie Bank", "Northwind Logistics", "+17805550100", 250000, "northwind.zip"]));
    expect(JSON.parse(String((inserts[1]![1] as unknown[])[11]))).toEqual(["application.pdf"]);
    // Nothing is created for the client, and nobody is texted.
    expect(callsMatching(h.query, /INSERT INTO applications|broker_imports|sms/i)).toHaveLength(0);
    expect(h.notify).toHaveBeenCalledTimes(1);
    expect((h.notify.mock.calls[0] as any)[0].body).toBe("Prairie Bank sent 2 declined files for review.");
  });

  it("reports each file that cannot be taken, and keeps the rest", async () => {
    const res = await request(app())
      .post("/api/lender-referrals/mine")
      .set("Authorization", lenderAuth)
      .field("details", JSON.stringify([good, { ...good, consent: false }, good]))
      .attach("files", makeZip([{ name: "a.pdf", data: "x" }]), "one.zip")
      .attach("files", makeZip([{ name: "b.pdf", data: "x" }]), "two.zip")
      .attach("files", Buffer.from("not a zip"), "three.pdf");
    expect(res.status).toBe(201);
    expect(res.body.results.map((r: any) => [r.ok, r.error ?? null])).toEqual([[true, null], [false, "consent_required"], [false, "zip_required"]]);
  });

  it("refuses a second file for a client already under review", async () => {
    h.query.mockImplementation(answerBySql([
      [/SELECT name FROM lenders/, { rows: [{ name: "Prairie Bank" }] }],
      [/SELECT id FROM lender_referrals/, { rows: [{ id: "existing" }] }],
    ]));
    const res = await request(app())
      .post("/api/lender-referrals/mine")
      .set("Authorization", lenderAuth)
      .field("details", JSON.stringify([good]))
      .attach("files", makeZip([{ name: "a.pdf", data: "x" }]), "one.zip");
    expect(res.status).toBe(400);
    expect(res.body.results[0].error).toBe("already_sent");
    expect(h.notify).not.toHaveBeenCalled();
  });

  it("is for lenders only", async () => {
    const staffToken = "Bearer " + jwt.sign({ sub: "u1", role: "Staff" }, process.env.JWT_SECRET as string);
    const res = await request(app()).get("/api/lender-referrals/mine").set("Authorization", staffToken);
    expect(res.status).toBe(403);
  });

  it("lists the lender's own files with status and share only", async () => {
    h.query.mockImplementation(answerBySql([
      [/FROM lender_referrals r/, (_s: string, p?: unknown[]) => ({ rows: p?.[0] === LENDER_ID ? [{
        id: "r1", business_name: "Northwind", client_name: "Jane", requested_amount: "250000.00", zip_name: "n.zip", status: "accepted",
        complete_package: true, created_at: "2026-10-19T16:00:00Z", decided_at: null, pipeline_state: "funded", payout_amount: "1500.00", payout_paid_on: "2026-11-01",
      }] : [] })],
    ]));
    const res = await request(app()).get("/api/lender-referrals/mine").set("Authorization", lenderAuth);
    expect(res.status).toBe(200);
    expect(res.body.files).toEqual([{
      id: "r1", business_name: "Northwind", client_name: "Jane", requested_amount: "250000.00", zip_name: "n.zip", sent_at: "2026-10-19T16:00:00Z",
      progress: "Funded", share: "50% of Boreal's fee", payout_amount: "1500.00", payout_paid_on: "2026-11-01",
    }]);
  });
});

// BF_SERVER_v827_REFERRAL_PIPELINE_CARD - files are imported into a pipeline card first; accepting adds the sign-in
// phone, the split and the text.
describe("staff accept or decline", () => {
  const referral = {
    id: "r1", lender_id: LENDER_ID, lender_name: "Prairie Bank", business_name: "Northwind Logistics", client_name: "Jane Smith",
    client_phone: "+17805550100", requested_amount: "250000.00", zip_name: "n.zip", zip_data: Buffer.from("zip"), application_id: null as string | null,
  };
  const dbFor = (over: Record<string, unknown> = {}, extra: Array<[RegExp, unknown]> = []) => ({ query: vi.fn(answerBySql([
    ...extra,
    [/SET status = 'accepting'/, { rows: [referral] }],
    [/FROM lender_referrals WHERE id::text = \$1 AND status IN/, { rows: [{ ...referral, ...over }] }],
    [/RETURNING metadata->'broker_prefill'/, { rows: [{ first_name: "Jane", import_id: "imp1" }] }],
  ])) });

  it("importing a file makes a draft card with no sign-in phone, and texts nobody", async () => {
    const db = dbFor();
    const importZip = vi.fn(async () => ({ importId: "imp1", applicationId: "app1", businessName: null, warnings: [], prefill: null }));
    expect(await importReferral("r1", { db, importZip })).toBe("app1");
    expect(importZip).toHaveBeenCalledWith(expect.objectContaining({ applicantPhone: null, brokerName: "Prairie Bank" }));
    expect(String(callsMatching(db.query, /'lender_referral'/)[0]![0])).toMatch(/- 'readiness_phone'/);
    expect(callsMatching(db.query, /broker_imports SET applicant_phone = NULL/)).toHaveLength(1);
    expect(callsMatching(db.query, /SET application_id = \$2.*zip_data = NULL/s)).toHaveLength(1);
  });

  it("a file that cannot be read keeps its zip and saves the reason", async () => {
    const db = dbFor();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(await importReferral("r1", { db, importZip: async () => { throw new Error("OCR is down"); } })).toBeNull();
    expect(callsMatching(db.query, /SET import_error = \$2/)[0]![1]).toEqual(["r1", "OCR is down"]);
    warn.mockRestore();
  });

  it("accepting gives the card the client's phone, records the 50% share, then texts the client", async () => {
    const db = dbFor({ application_id: "app1", zip_data: null });
    const sendSms = vi.fn(async () => ({ success: true }));
    const out = await acceptReferral("r1", { staffId: "s1", completePackage: true, note: null }, { db, sendSms, appUrl: "https://client.test" });
    expect(out).toEqual({ applicationId: "app1", texted: true, warnings: [] });
    expect(callsMatching(db.query, /jsonb_build_object\('readiness_phone'/)[0]![1]).toEqual(["app1", "+17805550100", true]);
    expect(callsMatching(db.query, /broker_imports SET applicant_phone = \$2/)[0]![1]).toEqual(["imp1", "+17805550100"]);
    const split = callsMatching(db.query, /INSERT INTO broker_deal_confirmations/)[0]![1] as unknown[];
    expect(split.slice(0, 5)).toEqual(["app1", "Prairie Bank", 50, 50, "Lender referral, complete package: 50% of Boreal's fee"]);
    expect(sendSms).toHaveBeenCalledWith(expect.objectContaining({ to: "+17805550100", message: expect.stringMatching(/^Hi Jane, Boreal Financial/) }));
    expect(sendSms.mock.calls[0]![0].message).not.toContain("Prairie");
  });

  it("an incomplete package records no share", async () => {
    const db = dbFor({ application_id: "app1", zip_data: null });
    await acceptReferral("r1", { staffId: "s1", completePackage: false, note: "No bank statements" }, { db, sendSms: async () => ({}) });
    const split = callsMatching(db.query, /INSERT INTO broker_deal_confirmations/)[0]![1] as unknown[];
    expect(split.slice(2, 5)).toEqual([100, 0, "Lender referral, incomplete package: no referral share"]);
  });

  it("puts the file back in the queue when it cannot be imported, and texts nobody", async () => {
    const db = dbFor();
    const sendSms = vi.fn();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await expect(acceptReferral("r1", { staffId: "s1", completePackage: true, note: null }, {
      db, importZip: async () => { throw new Error("bad"); }, sendSms,
    })).rejects.toMatchObject({ code: "import_failed", status: 422 });
    expect(callsMatching(db.query, /SET status = 'pending'/)).toHaveLength(1);
    expect(sendSms).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("refuses when another imported file is already waiting for that phone", async () => {
    const db = dbFor({ application_id: "app1", zip_data: null }, [[/SELECT id FROM applications/, { rows: [{ id: "other" }] }]]);
    await expect(acceptReferral("r1", { staffId: "s1", completePackage: true, note: null }, { db, sendSms: async () => ({}) }))
      .rejects.toMatchObject({ code: "phone_in_use" });
    expect(callsMatching(db.query, /SET status = 'pending'/)).toHaveLength(1);
  });

  it("a file already decided cannot be accepted or declined again", async () => {
    const db = { query: vi.fn(answerBySql([])) };
    await expect(acceptReferral("r1", { staffId: "s1", completePackage: true, note: null }, { db })).rejects.toMatchObject({ code: "not_pending" });
    await expect(declineReferral("r1", "s1", null, db)).rejects.toMatchObject({ code: "not_pending" });
  });

  it("declining deletes the zip and takes the card off the pipeline", async () => {
    const db = { query: vi.fn(answerBySql([[/SET status = 'declined'/, { rows: [{ id: "r1", application_id: "app1", import_id: "imp1" }] }]])) };
    await declineReferral("r1", "s1", "Outside our box", db);
    expect(String(callsMatching(db.query, /SET status = 'declined'/)[0]![0])).toMatch(/zip_data = NULL/);
    expect(String(callsMatching(db.query, /lender_referral_declined/)[0]![0])).toMatch(/- 'readiness_phone'/);
    expect(callsMatching(db.query, /broker_imports SET status = 'discarded'/)).toHaveLength(1);
  });
});
