import { describe, it, expect } from 'vitest';
import { pool } from "../src/db";

describe("database schema regression", () => {
  it("exposes required lender columns", async () => {
    const lenderColumns = await pool.query<{ column_name: string }>(
      `select column_name
       from information_schema.columns
       where table_schema = 'public'
         and table_name = 'lenders'`
    );
    const columnNames = new Set(lenderColumns.rows.map((row) => row.column_name));
    expect(columnNames.has("country")).toBe(true);
  });

  it("exposes required lender product columns", async () => {
    const productColumns = await pool.query<{ column_name: string }>(
      `select column_name
       from information_schema.columns
       where table_schema = 'public'
         and table_name = 'lender_products'`
    );
    const columnNames = new Set(productColumns.rows.map((row) => row.column_name));
    expect(columnNames.has("required_documents")).toBe(true);
  });
});
