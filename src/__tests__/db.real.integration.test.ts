if (!process.env.DATABASE_URL) {
  test.skip("real db not configured", () => {});
} else {
  test("real db connection works", async () => {
    const { queryDb } = await import("../lib/db");

    const res = await queryDb("SELECT 1 as ok");
    expect(res.rows[0].ok).toBe(1);
  });
}
