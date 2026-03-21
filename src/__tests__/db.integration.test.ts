import { describe, it, expect } from 'vitest';
import { pool } from '../lib/dbClient';

describe('DATABASE INTEGRATION', () => {
  it('should connect and execute query', async () => {
    const res = await pool.query('SELECT 1 as result');
    expect(res.rows[0].result).toBe(1);
  });

  it('should insert and read test row', async () => {
    await pool.query('CREATE TEMP TABLE test_table(id INT)');
    await pool.query('INSERT INTO test_table(id) VALUES(123)');
    const res = await pool.query('SELECT id FROM test_table');
    expect(res.rows[0].id).toBe(123);
  });
});
