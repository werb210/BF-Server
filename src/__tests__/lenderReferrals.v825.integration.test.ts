// BF_SERVER_v825_LENDER_REFERRALS - the lender referral SQL against the real schema (baseline + migrations): save a
// referral, the lender's list, the staff queue, accept (application metadata, the agreed 50% split, the referral
// row) and decline. The broker import itself is stubbed; it has its own coverage.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { pool } from "../db.js";
import {
  acceptReferral,
  declineReferral,
  listForLender,
  listForStaff,
  referralZip,
  saveReferral,
} from "../services/lenderReferrals/lenderReferrals.js";

const lenderId = randomUUID();
const appId = randomUUID();
const importId = randomUUID();
const tag = "v825" + Math.floor(Math.random() * 1e6);
const phoneA = `+178055501${String(10 + Math.floor(Math.random() * 90))}`;
const phoneB = `+140355501${String(10 + Math.floor(Math.random() * 90))}`;
let acceptedId = "";
let declinedId = "";

describe("v825 lender referrals against the real schema", () => {
  beforeAll(async () => {
    await pool.query("INSERT INTO lenders (id, name, country) VALUES ($1, $2, 'CA')", [lenderId, `Prairie Bank ${tag}`]);
  });

  afterAll(async () => {
    const clean = (sql: string, params: unknown[]) => pool.query(sql, params).catch((e) => console.warn("cleanup", String(e)));
    await clean("DELETE FROM lender_referrals WHERE lender_id = $1", [lenderId]);
    await clean("DELETE FROM broker_deal_confirmations WHERE application_id = $1", [appId]);
    await clean("DELETE FROM broker_imports WHERE id = $1", [importId]);
    await clean("DELETE FROM applications WHERE id = $1", [appId]);
    await clean("DELETE FROM lenders WHERE id = $1", [lenderId]);
  });

  it("saves referrals and lists them for the lender and for staff", async () => {
    // saveReferral reads the zip: build a real one-file zip.
    const body = Buffer.from("%PDF"); const name = Buffer.from("statements.pdf");
    const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt32LE(body.length, 18); lh.writeUInt32LE(body.length, 22); lh.writeUInt16LE(name.length, 26);
    const ch = Buffer.alloc(46); ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt32LE(body.length, 20); ch.writeUInt32LE(body.length, 24); ch.writeUInt16LE(name.length, 28);
    const cd = Buffer.concat([ch, name]); const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(30 + name.length + body.length, 16);
    const realZip = Buffer.concat([lh, name, body, cd, end]);

    const a = await saveReferral({ lenderId, lenderName: `Prairie Bank ${tag}`, uploadedBy: "lender:" + lenderId, zipName: "northwind.zip", zip: realZip,
      details: { businessName: `Northwind ${tag}`, clientName: "Jane Smith", clientPhone: phoneA, requestedAmount: 250000, declineReason: "Outside our box" } });
    const b = await saveReferral({ lenderId, lenderName: `Prairie Bank ${tag}`, uploadedBy: "lender:" + lenderId, zipName: "contoso.zip", zip: realZip,
      details: { businessName: `Contoso ${tag}`, clientName: null, clientPhone: phoneB, requestedAmount: null, declineReason: null } });
    acceptedId = a.id; declinedId = b.id;
    expect(a.fileNames).toEqual(["statements.pdf"]);
    await expect(saveReferral({ lenderId, lenderName: "x", uploadedBy: "x", zipName: "again.zip", zip: realZip,
      details: { businessName: "again", clientName: null, clientPhone: phoneA, requestedAmount: null, declineReason: null } })).rejects.toMatchObject({ code: "already_sent" });

    const mine = await listForLender(lenderId);
    expect(mine.map((f) => [f.business_name, f.progress, f.share])).toEqual([
      [`Contoso ${tag}`, "Under review", "-"],
      [`Northwind ${tag}`, "Under review", "-"],
    ]);
    expect(Object.keys(mine[0]!)).not.toContain("client_phone");
    const queue = (await listForStaff()).filter((r) => r.lender_id === lenderId);
    expect(queue).toHaveLength(2);
    expect(queue.every((r) => r.has_zip === true && r.status === "pending")).toBe(true);
    expect((await referralZip(acceptedId))?.data.equals(realZip)).toBe(true);
  });

  it("accepting records the referral on the application and the 50% split, and keeps no zip", async () => {
    const importZip = async (opts: { brokerName: string }) => {
      await pool.query(
        "INSERT INTO applications (id, name, created_at, updated_at, pipeline_state, status, source, metadata) VALUES ($1, $2, now(), now(), 'draft', 'RECEIVED', 'broker_import', jsonb_build_object('broker_import', jsonb_build_object('broker_name', $3::text, 'import_id', $4::text), 'readiness_phone', '+17805550199'))",
        [appId, `${opts.brokerName} file`, opts.brokerName, importId]);
      await pool.query("INSERT INTO broker_imports (id, broker_name, zip_name, application_id, status) VALUES ($1, $2, 'northwind.zip', $3, 'awaiting_client')", [importId, opts.brokerName, appId]);
      return { importId, applicationId: appId, businessName: null, warnings: [], prefill: null };
    };
    const texts: string[] = [];
    const out = await acceptReferral(acceptedId, { staffId: null, completePackage: true, note: "All docs in" }, {
      importZip, sendSms: async ({ message }) => { texts.push(message); return {}; }, appUrl: "https://client.test",
    });
    expect(out).toEqual({ applicationId: appId, texted: true, warnings: [] });
    const app = await pool.query("SELECT name, requested_amount, metadata->'lender_referral' AS ref FROM applications WHERE id = $1", [appId]);
    expect(app.rows[0].name).toBe(`Northwind ${tag}`);
    expect(Number(app.rows[0].requested_amount)).toBe(250000);
    expect(app.rows[0].ref).toMatchObject({ referral_id: acceptedId, lender_id: lenderId, complete_package: true });
    const phone = await pool.query("SELECT metadata->>'readiness_phone' AS p FROM applications WHERE id = $1", [appId]);
    expect(phone.rows[0].p).toBe(phoneA); // the client's cell from the lender, not the one read off the form
    expect(app.rows[0].ref.status).toBe("accepted");
    const split = await pool.query("SELECT boreal_pct, broker_pct, status, terms FROM broker_deal_confirmations WHERE application_id = $1", [appId]);
    expect(split.rows[0]).toMatchObject({ status: "accepted", terms: "Lender referral, complete package: 50% of Boreal's fee" });
    expect([Number(split.rows[0].boreal_pct), Number(split.rows[0].broker_pct)]).toEqual([50, 50]);
    expect(texts[0]).toBe("Hi Jane, Boreal Financial has your business financing application ready. To check it and finish, sign in with this mobile number at https://client.test");
    expect(await referralZip(acceptedId)).toBeNull();
    const imp = await pool.query("SELECT summary->>'client_texted_at' AS texted FROM broker_imports WHERE id = $1", [importId]);
    expect(imp.rows[0].texted).toBeTruthy();
    await expect(acceptReferral(acceptedId, { staffId: null, completePackage: true, note: null }, { importZip })).rejects.toMatchObject({ code: "not_pending" });
  });

  it("declining deletes the zip, and the lender sees each outcome", async () => {
    await declineReferral(declinedId, null, "Too early");
    expect(await referralZip(declinedId)).toBeNull();
    const mine = await listForLender(lenderId);
    const by = Object.fromEntries(mine.map((f) => [f.business_name, [f.progress, f.share]]));
    expect(by[`Contoso ${tag}`]).toEqual(["Not accepted", "-"]);
    expect(by[`Northwind ${tag}`]).toEqual(["Accepted - waiting for the client", "50% of Boreal's fee"]);
  });
});
