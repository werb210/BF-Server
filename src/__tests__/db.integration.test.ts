import { db } from '../db'; // adjust path if needed

describe('DB Integration (real write/read)', () => {
  it('should connect, write, and read from database', async () => {
    // 1. sanity check connection
    const result = await db.query('SELECT 1 as ok');
    expect(result.rows[0].ok).toBe(1);

    // 2. create temp table (isolated)
    await db.query(`
      CREATE TABLE IF NOT EXISTS test_db_health (
        id SERIAL PRIMARY KEY,
        value TEXT,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);

    // 3. insert row
    const insert = await db.query(
      `INSERT INTO test_db_health (value) VALUES ($1) RETURNING id, value`,
      ['test-write']
    );

    expect(insert.rows.length).toBe(1);
    const id = insert.rows[0].id;

    // 4. read row
    const read = await db.query(
      `SELECT value FROM test_db_health WHERE id = $1`,
      [id]
    );

    expect(read.rows[0].value).toBe('test-write');

    // 5. cleanup
    await db.query(`DELETE FROM test_db_health WHERE id = $1`, [id]);
  });
});
