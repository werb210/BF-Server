import express from "express";
import jwt from "jsonwebtoken";
import request from "supertest";
import { describe, it, expect, vi } from "vitest";
import { answerBySql, callsMatching, sqlText } from "../../../__tests__/helpers/answerBySql.js";

const h = vi.hoisted(() => ({ queryMock: vi.fn() }));
vi.mock("../../../db.js", async () => {
  const actual = await vi.importActual<typeof import("../../../db.js")>("../../../db.js");
  return { ...actual, pool: { query: h.queryMock } };
});

import { referralIntroBody, REFERRAL_SMS_VERSIONS } from "../referralInvite.js";
import referrerSelfRouter from "../../../routes/referrerSelf.js";

describe("BF_SERVER_REFERRAL_SMS_COPY_v1", () => {
  const url = "https://www.boreal.financial/r/f/ABC123";

  it("never sends the bare version key as the message body", () => {
    const a = referralIntroBody({ message: "A", referrerName: "Todd Werboweski", url });
    const b = referralIntroBody({ message: "B", referrerName: "Todd Werboweski", url });
    expect(a.split("\n")[0]).not.toBe("A");
    expect(b.split("\n")[0]).not.toBe("B");
    expect(a).toContain(url);
    expect(b).toContain(url);
  });

  it("version A includes the referrer name, version B does not", () => {
    const a = referralIntroBody({ message: "A", referrerName: "Todd Werboweski", url });
    const b = referralIntroBody({ message: "B", referrerName: "Todd Werboweski", url });
    expect(a).toContain("Todd Werboweski");
    expect(b).not.toContain("Todd Werboweski");
  });

  it("falls back to the nameless A copy when the referrer has no name", () => {
    expect(REFERRAL_SMS_VERSIONS.A(null)).not.toContain("null");
    expect(referralIntroBody({ message: "A", referrerName: null, url })).toContain(url);
  });

  it("treats anything that is not A or B as custom copy", () => {
    const out = referralIntroBody({ message: "Custom note here", referrerName: "Todd", url });
    expect(out).toBe(`Custom note here\n${url}`);
  });

  it("persists the full referrer profile field set", async () => {
    const REFERRER_ID = "77777777-7777-4777-8777-777777777777";
    const app = express();
    app.use(express.json());
    app.use("/api/referrer", referrerSelfRouter);
    const token = "Bearer " + jwt.sign({ sub: `referrer:${REFERRER_ID}`, role: "Referrer", referrerId: REFERRER_ID }, process.env.JWT_SECRET as string, { algorithm: "HS256" });
    h.queryMock.mockReset();
    h.queryMock.mockImplementation(answerBySql([]));
    const r = await request(app).post("/api/referrer/profile").set("Authorization", token).send({
      full_name: "Todd Werboweski", company_name: "Boreal", email: "t@example.test", phone: "+15875550100",
      street: "1 Main St", city: "Calgary", province: "AB", postal_code: "T2P 1A1", etransfer_email: "pay@example.test",
    });
    expect(r.status).toBe(200);
    const [upd] = callsMatching(h.queryMock, /UPDATE users/);
    const sql = sqlText(upd[0]);
    const params = upd[1] as unknown[];
    const expected: Record<string, string> = { street: "1 Main St", city: "Calgary", province: "AB", postal_code: "T2P 1A1", etransfer_email: "pay@example.test" };
    for (const [col, value] of Object.entries(expected)) {
      const m = sql.match(new RegExp(`${col} = COALESCE\\(\\$(\\d+), ${col}\\)`));
      expect(m, col).not.toBeNull();
      expect(params[Number(m![1]) - 1], col).toBe(value);
    }
    expect(params[0]).toBe(REFERRER_ID);
    // A partial edit keeps what is already stored (COALESCE with NULL).
    h.queryMock.mockClear();
    await request(app).post("/api/referrer/profile").set("Authorization", token).send({ city: "Edmonton" });
    const partial = callsMatching(h.queryMock, /UPDATE users/)[0][1] as unknown[];
    expect(partial.filter((v) => v !== null)).toEqual([REFERRER_ID, "Edmonton"]);
  });
});
