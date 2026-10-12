// BF_SERVER_UNDER_10K_WAITLIST_v735
import request from "supertest";
import { beforeEach, describe, it, expect, vi } from "vitest";
import { answerBySql, callsMatching } from "./helpers/answerBySql.js";
import { mountRouter, staffToken } from "./helpers/staffRouterApp.js";

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));
vi.mock("../db.js", async () => ({ ...(await vi.importActual<any>("../db.js")), pool: { query: queryMock }, dbQuery: queryMock }));

async function join(body: Record<string, unknown>) {
  const app = mountRouter((await import("../routes/crm.js")).default, "/api/crm");
  return request(app).post("/api/crm/startup-waitlist").set("Authorization", `Bearer ${staffToken()}`)
    .send({ name: "Wren Owner", email: "wren@example.com", ...body });
}
const tagUpdate = () => {
  const [call] = callsMatching(queryMock, /SET tags = /);
  expect(call).toBeDefined();
  return { sql: String(call[0]), params: call[1] as unknown[] };
};

beforeEach(() => {
  queryMock.mockReset().mockImplementation(answerBySql([[/insert into contacts/, { rows: [{ id: "new-1" }] }]]));
});

describe("waitlist lists and consent", () => {
  it("tags the under-$10k list separately from start-ups", async () => {
    const res = await join({ list: "under_10k" });
    expect(res.body).toMatchObject({ ok: true, list: "under_10k_revenue_waitlist" });
    expect(tagUpdate().params[1]).toBe("under_10k_revenue_waitlist");

    queryMock.mockClear();
    const other = await join({});
    expect(other.body.list).toBe("startup_waitlist");
    expect(tagUpdate().params[1]).toBe("startup_waitlist");
  });

  it("records express consent only when the box was ticked", async () => {
    await join({ consent: true });
    const ticked = tagUpdate();
    expect(ticked.params[2]).toBe(true);
    expect(ticked.sql).toContain("consent_basis  = CASE WHEN $3 THEN 'express' ELSE consent_basis END,");

    for (const consent of [undefined, false, "true", "yes"]) {
      queryMock.mockClear();
      await join({ consent });
      expect(tagUpdate().params[2], String(consent)).toBe(false);
    }
  });
});
