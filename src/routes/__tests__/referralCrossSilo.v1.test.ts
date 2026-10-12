// BF_SERVER_REFERRAL_CROSS_SILO_v1 - cross-silo referral invites and the conversion ledger.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import express from "express";
import jwt from "jsonwebtoken";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { answerBySql, callsMatching, sqlText } from "../../__tests__/helpers/answerBySql.js";

const h = vi.hoisted(() => ({ queryMock: vi.fn(), runQueryMock: vi.fn(), sendSms: vi.fn() }));
vi.mock("../../db.js", async () => {
  const actual = await vi.importActual<typeof import("../../db.js")>("../../db.js");
  const pool = { query: h.queryMock, connect: async () => ({ query: h.queryMock, release: () => undefined }) };
  return { ...actual, pool, runQuery: h.runQueryMock, dbQuery: h.queryMock, db: pool };
});
vi.mock("../../modules/notifications/sms.service.js", () => ({ sendSms: h.sendSms }));

import referrerSelfRouter from "../referrerSelf.js";
import referralsExtRouter from "../referralsExt.js";
import { API_ROUTE_MOUNTS } from "../routeRegistry.js";
import {
  REFERRAL_CONVERSION_RATE,
  creditBiReferralConversion,
  creditReferralConversion,
} from "../../modules/referrals/referralConversions.service.js";

const REFERRER_ID = "77777777-7777-4777-8777-777777777777";
const migration = readFileSync(join(process.cwd(), "migrations", "2026_07_10_referral_cross_silo.sql"), "utf8");
const sign = (claims: Record<string, unknown>) => "Bearer " + jwt.sign(claims, process.env.JWT_SECRET as string, { algorithm: "HS256" });
const referrer = () => sign({ sub: `referrer:${REFERRER_ID}`, role: "Referrer", referrerId: REFERRER_ID });

beforeEach(() => {
  h.sendSms.mockReset();
  h.sendSms.mockResolvedValue(undefined);
  h.queryMock.mockReset();
  h.queryMock.mockImplementation(answerBySql([]));
  h.runQueryMock.mockReset();
  h.runQueryMock.mockImplementation(answerBySql([]));
});

describe("BF_SERVER_REFERRAL_CROSS_SILO_v1", () => {
  it("the referrer self-service route accepts a cross-silo invite and returns the minted code", async () => {
    h.queryMock.mockImplementation(answerBySql([
      [/insert into companies/, (_s: string, p?: unknown[]) => ({ rows: [{ id: p?.[0], name: p?.[1] }] })],
      [/insert into contacts/, (_s: string, p?: unknown[]) => ({ rows: [{ id: p?.[0], name: p?.[1] }] })],
    ]));
    const app = express();
    app.use(express.json());
    app.use("/api/referrer", referrerSelfRouter);
    const r = await request(app).post("/api/referrer/add-referral").set("Authorization", referrer()).send({
      full_name: "Ann Lee", phone: "+15875550100", company_name: "Lee Holdings",
      silos: ["bi", "BF", "nope", "bf"], message: "A", referrerName: "Todd W",
    });
    expect(r.status).toBe(201);
    expect(r.body.data.silos).toEqual(["BI", "BF"]);
    const refCode = r.body.data.refCode as string;
    expect(refCode).toMatch(/^BF-[0-9A-F]{8}$/);

    // The minted code is stored on the contact with the silos and the chosen message.
    const [stamp] = callsMatching(h.queryMock, /SET ref_code = \$2/);
    expect((stamp[1] as unknown[]).slice(1)).toEqual([refCode, ["BI", "BF"], "A"]);

    // ...and the invite SMS carries it, in the referrer's name, to the both-silos landing.
    expect(h.sendSms).toHaveBeenCalledTimes(1);
    const sms = h.sendSms.mock.calls[0][0] as { to: string; message: string };
    expect(sms.to).toBe("+15875550100");
    expect(sms.message).toContain("Todd W");
    expect(sms.message).toContain(`/r/b/${refCode}`);
  });

  it("has an additive conversion ledger with 20 percent idempotent crediting", async () => {
    expect(migration).toContain("CREATE TABLE IF NOT EXISTS referral_conversions");
    expect(migration).toContain("conversion_rate numeric NOT NULL DEFAULT 20");
    expect(migration).toContain("referral_conversions_application_uidx");
    expect(migration).toContain("referral_conversions_external_uidx");
    expect(REFERRAL_CONVERSION_RATE).toBe(20);

    h.runQueryMock.mockImplementation(answerBySql([[/INSERT INTO referral_conversions/, { rows: [{ id: "conv-1" }] }]]));
    await expect(creditReferralConversion({ applicationId: "app-1", dealAmount: 50000 })).resolves.toEqual({ id: "conv-1" });
    const [bf] = callsMatching(h.runQueryMock, /INSERT INTO referral_conversions/);
    expect(sqlText(bf[0])).toContain("ON CONFLICT (application_id) WHERE application_id IS NOT NULL DO UPDATE");
    expect(bf[1]).toEqual(["app-1", null, null, 50000, 20]);

    h.queryMock.mockImplementation(answerBySql([[/INSERT INTO referral_conversions/, { rows: [{ id: "conv-2" }] }]]));
    await expect(creditBiReferralConversion({ refCode: "BF-ABCDEF12", externalApplicationId: "bi-9", dealAmount: 1000 })).resolves.toEqual({ id: "conv-2" });
    const [bi] = callsMatching(h.queryMock, /INSERT INTO referral_conversions/);
    expect(sqlText(bi[0])).toContain("ON CONFLICT (source_silo, external_application_id) WHERE external_application_id IS NOT NULL DO UPDATE");
    expect(bi[1]).toEqual(["BF-ABCDEF12", "bi-9", 1000, 20]);
  });

  // BF_SERVER_BLOCK_v574 - moved to its own mount (REFERRALS_EXT_MOUNT_v1) because it collided
  // with /referrals; BI-Server's notifyBfReferralConversion posts to /api/referrals-ext/from-bi.
  it("mounts service-JWT protected BI ingest under /api/referrals-ext/from-bi", async () => {
    const mount = API_ROUTE_MOUNTS.find((m) => m.path === "/referrals-ext");
    expect(mount?.router).toBe(referralsExtRouter);

    const app = express();
    app.use(express.json());
    app.use("/api/referrals-ext", referralsExtRouter);
    const body = { ref_code: "BF-ABCDEF12", bi_application_id: "bi-9", deal_amount: 1000 };
    expect((await request(app).post("/api/referrals-ext/from-bi").send(body)).status).toBe(401);
    expect(callsMatching(h.queryMock, /referral_conversions/)).toHaveLength(0);

    h.queryMock.mockImplementation(answerBySql([[/INSERT INTO referral_conversions/, { rows: [{ id: "conv-3" }] }]]));
    const admin = sign({ sub: "11111111-1111-4111-8111-111111111111", role: "Admin", tokenVersion: 0, tv: 0 });
    const ok = await request(app).post("/api/referrals-ext/from-bi").set("Authorization", admin).send(body);
    expect(ok.status).toBe(200);
    expect(ok.body.data).toEqual({ conversionId: "conv-3" });
    expect((await request(app).post("/api/referrals-ext/from-bi").set("Authorization", admin).send({ ref_code: "x" })).status).toBe(400);
  });
});
