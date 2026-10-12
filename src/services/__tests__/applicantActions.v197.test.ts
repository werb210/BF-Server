// BF_SERVER_APPLICANT_ACTION_CENTER_v197 (route checks; service rules moved to v544 test)
import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { answerBySql } from "../../__tests__/helpers/answerBySql.js";
import { clientToken } from "../../__tests__/helpers/v1AppsHarness.js";

const { queryMock, buildActionCenter } = vi.hoisted(() => ({
  queryMock: vi.fn(),
  buildActionCenter: vi.fn(async () => ({ outstandingCount: 2, outstanding: [], completed: [] })),
}));
vi.mock("../../db.js", () => ({ pool: { query: queryMock }, runQuery: queryMock }));
vi.mock("../applicantActions.js", () => ({ buildActionCenter }));

const APP = "33333333-4444-4555-8666-777777777777";
const OWNERSHIP = /SELECT COUNT\(\*\)::text AS n FROM app_phones/;

async function app() {
  const { default: router } = await import("../../routes/clientDocumentsNeeded.js");
  const a = express();
  a.use("/api/client/documents-needed", router);
  return a;
}

describe("route", () => {
  beforeEach(() => {
    queryMock.mockReset();
    buildActionCenter.mockClear();
  });

  it("rejects a malformed application id before touching the database", async () => {
    for (const bad of ["", "not-a-uuid", `${APP}x`, "'; drop table x; --"]) {
      const res = await request(await app())
        .get("/api/client/documents-needed/action-center")
        .query({ applicationId: bad })
        .set("Authorization", `Bearer ${clientToken()}`);
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: "invalid_application_id" });
    }
    expect(queryMock).not.toHaveBeenCalled();
    expect(buildActionCenter).not.toHaveBeenCalled();
  });

  it("enforces the same ownership check as the docs-needed route", async () => {
    queryMock.mockImplementation(answerBySql([[OWNERSHIP, { rows: [{ n: "0" }] }]]));
    const notMine = await request(await app())
      .get("/api/client/documents-needed/action-center")
      .query({ applicationId: APP })
      .set("Authorization", `Bearer ${clientToken()}`);
    expect(notMine.status).toBe(403);
    expect(notMine.body).toEqual({ error: "forbidden" });

    const anonymous = await request(await app()).get("/api/client/documents-needed/action-center").query({ applicationId: APP });
    expect(anonymous.status).toBe(403);
    expect(buildActionCenter).not.toHaveBeenCalled();
  });

  it("builds the list for the owner", async () => {
    queryMock.mockImplementation(answerBySql([[OWNERSHIP, { rows: [{ n: "1" }] }]]));
    const res = await request(await app())
      .get("/api/client/documents-needed/action-center")
      .query({ applicationId: APP })
      .set("Authorization", `Bearer ${clientToken()}`);
    expect(res.status).toBe(200);
    expect(res.body.outstandingCount).toBe(2);
    expect(buildActionCenter).toHaveBeenCalledWith(APP);
  });
});
