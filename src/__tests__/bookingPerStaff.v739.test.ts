// BF_SERVER_BOOKING_PER_STAFF_v739
import express from "express";
import request from "supertest";
import { beforeEach, describe, it, expect, vi } from "vitest";
import { answerBySql } from "./helpers/answerBySql.js";

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));
vi.mock("../db.js", async (orig) => ({ ...(await orig<Record<string, unknown>>()), pool: { query: queryMock } }));

import { slugOf } from "../routes/clientBooking.js";

const TEAM = [
  { id: "u-todd", email: "todd.w@boreal.financial", first_name: "Todd", mailbox: "todd.w@boreal.financial", signed_in: true },
  { id: "u-andrew", email: "andrew.p@boreal.financial", first_name: null, mailbox: "andrew.p@boreal.financial", signed_in: true },
];
beforeEach(() => {
  queryMock.mockReset();
  queryMock.mockImplementation(answerBySql([[/FROM users/, { rows: TEAM }]]));
});
async function app() {
  const a = express();
  a.use(express.json());
  a.use("/api/public/booking", (await import("../routes/clientBooking.js")).default);
  return a;
}

describe("per-advisor booking links", () => {
  it("names each link after the advisor's first name", () => {
    expect(slugOf("Todd", "todd.w@boreal.financial")).toBe("todd");
    expect(slugOf(null, "andrew.p@boreal.financial")).toBe("andrew");
  });
  it("the public API looks up one advisor and never lists the team", async () => {
    const one = await request(await app()).get("/api/public/booking/staff/Todd");
    expect(one.status).toBe(200);
    expect(one.body).toEqual({ staff: { id: "u-todd", firstName: "Todd", slug: "todd" } });
    expect(JSON.stringify(one.body)).not.toContain("@");
    const byEmailName = await request(await app()).get("/api/public/booking/staff/andrew");
    expect(byEmailName.body.staff).toEqual({ id: "u-andrew", firstName: "your advisor", slug: "andrew" });
    expect((await request(await app()).get("/api/public/booking/staff/nobody")).status).toBe(404);
    const list = await request(await app()).get("/api/public/booking/staff");
    expect(list.status).toBe(404);
    expect(JSON.stringify(list.body ?? {})).not.toContain("u-todd");
  });
});
