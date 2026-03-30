const { randomUUID } = require("crypto");

if (!process.env.NODE_ENV) process.env.NODE_ENV = "test";

async function run() {
  const { pool } = require("../dist/db");
  const suffix = randomUUID().replace(/-/g, "");
  const tableName = `runtime_db_roundtrip_${suffix}`;
  const rowId = randomUUID();

  try {
    await pool.query("select 1");
    await pool.query(`
      create table ${tableName} (
        id uuid primary key,
        value_text text not null,
        created_at timestamptz not null default now()
      )
    `);

    await pool.query(`insert into ${tableName} (id, value_text) values ($1, $2)`, [
      rowId,
      "runtime-roundtrip-ok",
    ]);

    const result = await pool.query(
      `select id, value_text from ${tableName} where id = $1`,
      [rowId]
    );

    if (result.rowCount !== 1) {
      throw new Error(`Expected 1 row, got ${result.rowCount}`);
    }

    if (result.rows[0].id !== rowId || result.rows[0].value_text !== "runtime-roundtrip-ok") {
      throw new Error(`Validation failed: ${JSON.stringify(result.rows[0])}`);
    }

    console.log("runtime db integration: OK");
  } finally {
    await pool.query(`drop table if exists ${tableName}`);
    await pool.end();
  }
}

run().catch((err) => {
  console.error("runtime db integration: FAILED", err);
  process.exit(1);
});
