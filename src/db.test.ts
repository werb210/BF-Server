import { describe, expect, it } from "vitest";
import { pool } from "./db";

describe("db module", () => {
  it("exports an initialized pool", async () => {
    const result = await pool.query("select 1 as ok");
    expect(result.rows[0]?.ok).toBe(1);
  });
});
