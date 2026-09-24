// BF_SERVER_v75_BLOCK_1_8
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import express from "express";
import request from "supertest";
import { pool } from "../../src/db.js";
import jwt from "jsonwebtoken";
import router from "../../src/routes/offerAcceptance";

// BF_SERVER_BLOCK_v476 - accept/decline now require a login
const staffAuth = () => `Bearer ${jwt.sign({ userId: "u-staff", role: "Staff" }, process.env.JWT_SECRET as string)}`;
const clientAuth = () => `Bearer ${jwt.sign({ userId: "u-client", role: "Client", phone: "+14035550100" }, process.env.JWT_SECRET as string)}`;

const queryMock = vi.spyOn(pool, "query");

function app() {
  const a = express();
  a.use(express.json());
  a.use(router);
  return a;
}

beforeEach(() => {
  queryMock.mockReset();
});

afterEach(() => {
  queryMock.mockReset();
});

describe("offer acceptance routes", () => {
  it("POST /:id/accept stages -> pending_acceptance", async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ id: "OFF1", status: "pending_acceptance" }] } as any);
    const r = await request(app()).post("/OFF1/accept").set("Authorization", staffAuth()).send({});
    expect(r.status).toBe(200);
    expect(r.body.offer.status).toBe("pending_acceptance");
  });

  it("POST /:id/accept returns 409 if offer cannot be staged", async () => {
    queryMock.mockResolvedValueOnce({ rows: [] } as any);
    const r = await request(app()).post("/OFFX/accept").set("Authorization", staffAuth()).send({});
    expect(r.status).toBe(409);
    expect(r.body.error).toBe("offer_not_acceptable");
  });

  it("v476: refuses accept with no login", async () => {
    const r = await request(app()).post("/OFF1/accept").send({});
    expect(r.status).toBe(401);
    expect(queryMock).not.toHaveBeenCalled();
  });

  it("v476: refuses a client who does not own the offer's application", async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ mine: 0 }] } as any);
    const r = await request(app()).post("/OFF1/decline").set("Authorization", clientAuth()).send({});
    expect(r.status).toBe(403);
  });

  it("v476: lets the owning client accept", async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ mine: 1 }] } as any);
    queryMock.mockResolvedValueOnce({ rows: [{ id: "OFF1", status: "pending_acceptance" }] } as any);
    const r = await request(app()).post("/OFF1/accept").set("Authorization", clientAuth()).send({});
    expect(r.status).toBe(200);
  });
});
