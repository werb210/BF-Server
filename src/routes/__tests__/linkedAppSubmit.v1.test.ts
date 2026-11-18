// BF_SERVER_COMPANION_SUBMIT_GUARD_v1 / BF_SERVER_LINKED_STAGE_SYNC_v1 /
// BF_SERVER_SUBMITTED_NOT_DRAFT_v1 - 17 Nov application test findings.
import express from "express";
import request from "supertest";
import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { queryMock, state } = vi.hoisted(() => ({
  queryMock: vi.fn(),
  state: { kind: null as string | null, calls: [] as string[] },
}));

vi.mock("../../db.js", async () => ({
  pool: { query: queryMock, connect: vi.fn(async () => ({ query: queryMock, release: vi.fn() })) },
  runQuery: queryMock,
  dbQuery: queryMock,
  query: queryMock,
  safeQuery: queryMock,
}));

describe("client submit of a linked application", () => {
  beforeEach(() => {
    vi.resetModules();
    state.calls = [];
    queryMock.mockReset();
    queryMock.mockImplementation(async (sql: string) => {
      state.calls.push(sql);
      if (sql.includes("parent_application_id IS NOT NULL") && sql.includes("AS kind")) {
        return { rows: state.kind ? [{ id: "comp-1", kind: state.kind }] : [] };
      }
      if (sql.includes("FROM applications") && (sql.includes("WHERE id = $1") || sql.includes("WHERE id::text = ($1)::text"))) {
        return { rows: [{ id: "comp-1", silo: "BF", owner_user_id: null }] };
      }
      return { rows: [] };
    });
  });

  async function app() {
    const router = (await import("../client/v1Applications.js")).default;
    const a = express();
    a.use(express.json());
    a.use("/api/client", router);
    return a;
  }

  it("leaves a closing-costs companion alone and only stamps submitted_at", async () => {
    state.kind = "closing_costs";
    const res = await request(await app())
      .post("/api/client/applications/comp-1/submit")
      .send({ app: { productCategory: "EQUIPMENT_FINANCE", requires_closing_cost_funding: true, kyc: { fundingAmount: "425000" } } });
    expect(res.status).toBe(200);
    expect(res.body?.data?.linked).toBe("closing_costs");
    const writes = state.calls.filter((s) => /UPDATE applications|INSERT INTO applications/.test(s));
    expect(writes).toHaveLength(1);
    expect(writes[0]).toContain("submitted_at = COALESCE(submitted_at, now())");
    expect(writes[0]).not.toContain("product_category");
    expect(writes[0]).not.toContain("requested_amount");
  });
});

describe("submit SQL", () => {
  const src = readFileSync(new URL("../client/v1Applications.ts", import.meta.url), "utf8");

  it("inserts the closing-costs companion with an allowed status", () => {
    const insert = src.slice(src.indexOf("'closing_costs_companion',") - 400, src.indexOf("'closing_costs_companion',"));
    expect(insert).toContain("'Received', 'RECEIVED'");
    expect(insert).not.toContain("'received'");
  });

  it("moves linked applications to Documents Required with their parent", () => {
    expect(src).toContain("BF_SERVER_LINKED_STAGE_SYNC_v1");
    expect(src).toMatch(/c\.parent_application_id::text = p\.id::text[\s\S]*p\.pipeline_state = 'Documents Required'/);
  });

  it("clears isDraft and client_removed on submit", () => {
    expect(src).toContain("jsonb_build_object('isDraft', false)");
    expect(src).toContain("- 'client_removed'");
  });

  it("marks a backfilled companion as submitted", () => {
    expect(src).toContain("BF_SERVER_COMPANION_SUBMITTED_v1");
  });
});
