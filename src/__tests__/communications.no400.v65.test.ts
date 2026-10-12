// BF_SERVER_v65_COMMS_NO_400
import express from "express";
import jwt from "jsonwebtoken";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { answerBySql, callsMatching } from "./helpers/answerBySql.js";

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));
vi.mock("../db.js", async () => {
  const actual = await vi.importActual<typeof import("../db.js")>("../db.js");
  return { ...actual, pool: { query: queryMock }, runQuery: queryMock };
});

const STAFF_ID = "00000000-0000-4000-8000-0000000000a1";
const CONTACT = "11111111-2222-4333-8444-555555555555";
const token = () => jwt.sign({ sub: STAFF_ID, id: STAFF_ID, role: "Admin", tokenVersion: 0, tv: 0 }, String(process.env.JWT_SECRET));

async function app() {
  const router = (await import("../routes/communications.js")).default;
  const a = express();
  a.use(express.json());
  a.use("/api/communications", router);
  return a;
}

beforeEach(() => {
  queryMock.mockReset();
  queryMock.mockImplementation(answerBySql([
    [/FROM communications_messages/, { rows: [{ id: "m1", body: "hi", contact_id: CONTACT }], rowCount: 1 }],
  ]));
});

describe("BF_SERVER_v65_COMMS_NO_400", () => {
  it("missing contact_id returns 200 with empty messages, not 400", async () => {
    const res = await request(await app()).get("/api/communications/messages").set("Authorization", `Bearer ${token()}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ messages: [], total: 0 });
    expect(callsMatching(queryMock, "FROM communications_messages")).toHaveLength(0);
  });

  it("with a contact_id the thread is read and returned", async () => {
    const res = await request(await app()).get(`/api/communications/messages?contact_id=${CONTACT}`).set("Authorization", `Bearer ${token()}`);
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(res.body.messages[0].id).toBe("m1");
    const [call] = callsMatching(queryMock, "FROM communications_messages");
    expect(call![1]).toEqual([CONTACT, "BF"]);
  });
});
