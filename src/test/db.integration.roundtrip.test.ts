import { describe, it, expect } from 'vitest';
import { randomUUID } from "crypto";
import { pool } from "../db";

describe("DB integration roundtrip (test env)", () => {
  it("connects, creates table, inserts row, reads row, validates", async () => {
    const suffix = randomUUID().replace(/-/g, "");
    const tableName = `it_db_roundtrip_${suffix}`;
    const rowId = randomUUID();

    await pool.query("select 1");
    await pool.query(
      `create table ${tableName} (
        id uuid primary key,
        value_text text not null,
        created_at timestamptz not null default now()
      )`
    );

    await pool.query(`insert into ${tableName} (id, value_text) values ($1, $2)`, [
      rowId,
      "roundtrip-ok",
    ]);

    const result = await pool.query<{ id: string; value_text: string }>(
      `select id, value_text from ${tableName} where id = $1`,
      [rowId]
    );

    expect(result.rowCount).toBe(1);
    expect(result.rows[0]).toMatchObject({
      id: rowId,
      value_text: "roundtrip-ok",
    });

    await pool.query(`drop table if exists ${tableName}`);
  });
});
