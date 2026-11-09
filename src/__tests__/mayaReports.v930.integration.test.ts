// BF_SERVER_v930_MAYA_REPORTS - every whitelisted Maya table runs against the real schema.
import { describe, expect, it } from "vitest";
import { pool } from "../db.js";
import { runTable } from "../services/reports/mayaReports.js";

const SPECS: Array<[string, string, "count" | "total_amount"]> = [
  ["applications", "stage", "count"], ["applications", "product", "total_amount"], ["applications", "source", "count"],
  ["applications", "owner", "count"], ["applications", "month", "total_amount"],
  ["contacts", "lead_status", "count"], ["contacts", "stage", "count"], ["contacts", "owner", "count"], ["contacts", "month", "count"], ["contacts", "tag", "count"],
];

describe("v930 Maya tables (real Postgres)", () => {
  it.each(SPECS)("%s by %s (%s)", async (object, group_by, measure) => {
    for (const days of [null, 30]) {
      const out = await runTable({ title: "t", object: object as any, group_by, measure, days }, "BF", pool as any);
      expect(Array.isArray(out.rows)).toBe(true);
    }
  });
});
