if (!process.env.DATABASE_URL) {
  test.skip("real db not configured", () => {});
} else {
  describe("real db integration", () => {
    const originalNodeEnv = process.env.NODE_ENV;

    beforeAll(async () => {
      process.env.NODE_ENV = "development";
      const { runQuery } = await import("../lib/db");
      await expect(runQuery("SELECT 1")).resolves.toBeDefined();
    });

    afterAll(() => {
      process.env.NODE_ENV = originalNodeEnv;
    });

    test("real db connection works", async () => {
      const { runQuery } = await import("../lib/db");
      const res = await runQuery("SELECT 1 as ok");
      expect(res.rows).toHaveLength(1);
      expect(res.rows[0]).toEqual({ ok: 1 });
    });

    test("real db supports basic deterministic query behavior", async () => {
      const { runQuery } = await import("../lib/db");
      const marker = `from_real_test_${Date.now()}`;
      const insert = await runQuery(`INSERT INTO health_check (status) VALUES ($1) RETURNING status`, [marker]);
      expect(insert.rows[0]).toEqual({ status: marker });

      const after = await runQuery(`SELECT COUNT(*)::int AS count FROM health_check WHERE status = $1`, [marker]);
      expect(after.rows[0].count).toBeGreaterThan(0);
    });
  });
}
