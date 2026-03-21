import { describe, it, expect } from 'vitest';
import request from "supertest";
import { buildAppWithApiRoutes } from "../../app";
import { pool } from "../../db";

const app = buildAppWithApiRoutes();

async function ensureSubmissionSchema(): Promise<void> {
  await pool.query(`
    create table if not exists applications (
      id text primary key,
      owner_user_id uuid not null references users(id) on delete cascade,
      name text not null,
      metadata jsonb null,
      product_type text not null,
      pipeline_state text not null,
      status text not null default 'RECEIVED',
      lender_id uuid null,
      lender_product_id uuid null,
      requested_amount numeric null,
      source text null,
      created_at timestamp not null,
      updated_at timestamp not null
    );
  `);
}

beforeAll(async () => {
  await ensureSubmissionSchema();
  await pool.query(
    "insert into users (id) values ($1) on conflict (id) do nothing",
    ["00000000-0000-0000-0000-000000000001"]
  );
});

beforeEach(async () => {
  await pool.query("delete from applications");
});

describe("POST /api/client/submissions", () => {
  it("creates application with lender + product", async () => {
    const res = await request(app)
      .post("/api/client/submissions")
      .send({
        business_name: "Test Co",
        requested_amount: 100000,
        lender_id: "11111111-1111-1111-1111-111111111111",
        product_id: "22222222-2222-2222-2222-222222222222",
      });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);

    const row = await pool.query(
      "select lender_id, lender_product_id from applications where id = $1",
      [res.body.id]
    );

    expect(row.rows[0]?.lender_id).toBe("11111111-1111-1111-1111-111111111111");
    expect(row.rows[0]?.lender_product_id).toBe(
      "22222222-2222-2222-2222-222222222222"
    );
  });
});
