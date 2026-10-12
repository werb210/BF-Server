// BF_SERVER_PASS_REASON_OPTIONAL_v222
import express from "express";
import jwt from "jsonwebtoken";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { answerBySql, callsMatching } from "../../../__tests__/helpers/answerBySql.js";

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));
vi.mock("../../../db", async () => {
  const actual = await vi.importActual<typeof import("../../../db.js")>("../../../db");
  return { ...actual, pool: { query: queryMock }, runQuery: queryMock, dbQuery: queryMock };
});

const APP_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const LENDER_ID = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const token = () => jwt.sign({ sub: "00000000-0000-4000-8000-0000000000b1", role: "Staff", tokenVersion: 0, tv: 0 }, process.env.JWT_SECRET as string);

async function pass(body: Record<string, unknown>) {
  const router = (await import("../applications.routes.js")).default;
  const { errorHandler } = await import("../../../middleware/errors.js");
  const app = express();
  app.use(express.json());
  app.use("/api/applications", router);
  app.use(errorHandler);
  return request(app).post(`/api/applications/${APP_ID}/lender-response`).set("Authorization", `Bearer ${token()}`).send({ lenderId: LENDER_ID, ...body });
}

beforeEach(() => {
  queryMock.mockReset();
  queryMock.mockImplementation(answerBySql([
    [/row_number\(\) OVER/, { rows: [{ lender_id: LENDER_ID, ordinal: "1" }] }],
    [/SELECT label FROM rejection_reasons/, (_sql: string, params?: unknown[]) => ({
      rows: ((params?.[0] as string[]) ?? []).map((c) => ({ label: c === "tib" ? "Time in business" : "Credit score" })),
    })],
  ]));
});

const recorded = () => callsMatching(queryMock, /INSERT INTO application_lender_responses/);
const codesStored = () => callsMatching(queryMock, /INSERT INTO application_rejection_reasons/).map((c) => (c[1] as unknown[])[2]);

describe("recording a lender pass", () => {
  it("no longer rejects an empty note outright", async () => {
    // The portal modal labels the note optional; the server used to 400 on it.
    const res = await pass({ reason: "", reasonCodes: ["tib"] });
    expect(res.status).toBe(200);
    expect(recorded()).toHaveLength(1);
  });

  it("accepts reason codes instead of free text", async () => {
    const res = await pass({ reasonCodes: ["tib", "credit"] });
    expect(res.status).toBe(200);
    expect(res.body.data.reason).toBe("time in business; credit score");
    expect(codesStored()).toEqual(["tib", "credit"]);
  });

  it("still refuses a pass with no why at all", async () => {
    // Loosening this into "anything goes" would lose the decline reason that
    // the lender summary is built from.
    const res = await pass({ reason: "   " });
    expect(res.status).toBe(400);
    expect(res.body.message).toBe("Select at least one reason code, or write a note.");
    expect(recorded()).toHaveLength(0);
  });

  it("ignores blank entries in the codes array", async () => {
    const blanks = await pass({ reasonCodes: ["", "  ", null] });
    expect(blanks.status).toBe(400);
    const mixed = await pass({ reasonCodes: ["", "tib", "  "] });
    expect(mixed.status).toBe(200);
    expect(codesStored()).toEqual(["tib"]);
  });

  it("does not assume reasonCodes is an array", async () => {
    const noNote = await pass({ reasonCodes: "tib" });
    expect(noNote.status).toBe(400);
    const withNote = await pass({ reasonCodes: "tib", reason: "Too early" });
    expect(withNote.status).toBe(200);
    expect(withNote.body.data.reason).toBe("Too early");
    expect(codesStored()).toEqual([]);
  });
});
