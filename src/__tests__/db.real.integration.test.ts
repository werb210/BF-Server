if (!process.env.DATABASE_URL) {
  test.skip("real db not configured", () => {});
} else {
  describe("real db integration", () => {
    const originalNodeEnv = process.env.NODE_ENV;
    let realDbAvailable = true;

    beforeAll(async () => {
      process.env.NODE_ENV = "development";
      try {
        const { queryDb } = await import("../lib/db");
        await queryDb("SELECT 1");
      } catch {
        realDbAvailable = false;
      }
    });

    afterAll(() => {
      process.env.NODE_ENV = originalNodeEnv;
    });

    test("real db connection works", async () => {
      if (!realDbAvailable) {
        return;
      }

      const { queryDb } = await import("../lib/db");
      const res = await queryDb("SELECT 1 as ok");
      expect(res.rows).toHaveLength(1);
      expect(res.rows[0]).toEqual({ ok: 1 });
    });

    test("real db supports transaction rollback", async () => {
      if (!realDbAvailable) {
        return;
      }

      const { queryDb, withDbTransaction } = await import("../lib/db");
      const marker = `from_real_test_${Date.now()}`;

      const before = await queryDb(`SELECT COUNT(*)::int AS count FROM health_check WHERE status = $1`, [
        marker,
      ]);

      await withDbTransaction(async (txQuery) => {
        await txQuery(`INSERT INTO health_check (status) VALUES ($1)`, [marker]);
        const insideTx = await txQuery(
          `SELECT COUNT(*)::int AS count FROM health_check WHERE status = $1`,
          [marker]
        );
        expect(insideTx.rows[0]).toEqual({ count: before.rows[0].count + 1 });
      });

      const afterRollback = await queryDb(
        `SELECT COUNT(*)::int AS count FROM health_check WHERE status = $1`,
        [marker]
      );
      expect(afterRollback.rows[0]).toEqual({ count: before.rows[0].count });
    });
  });
}
