import { queryDb } from "../lib/db";
import { withTestTransaction } from "../lib/db.test";

describe("test db integration", () => {
  test("supports insert/select/update/delete deterministically", async () => {
    await withTestTransaction(async () => {
      const insertRes = await queryDb(
        `INSERT INTO health_check (status) VALUES ($1) RETURNING id, status`,
        ["ok"]
      );
      expect(insertRes.rows).toHaveLength(1);
      expect(insertRes.rows[0]).toEqual({ id: 1, status: "ok" });

      const selectRes = await queryDb(`SELECT id, status FROM health_check ORDER BY id ASC`);
      expect(selectRes.rows).toHaveLength(1);
      expect(selectRes.rows[0]).toEqual({ id: 1, status: "ok" });

      const updateRes = await queryDb(
        `UPDATE health_check SET status = $1 WHERE id = $2 RETURNING id, status`,
        ["updated", insertRes.rows[0].id]
      );
      expect(updateRes.rows).toHaveLength(1);
      expect(updateRes.rows[0]).toEqual({ id: 1, status: "updated" });

      const deleteRes = await queryDb(
        `DELETE FROM health_check WHERE id = $1 RETURNING id, status`,
        [insertRes.rows[0].id]
      );
      expect(deleteRes.rows).toHaveLength(1);
      expect(deleteRes.rows[0]).toEqual({ id: 1, status: "updated" });

      const finalSelect = await queryDb(`SELECT id, status FROM health_check`);
      expect(finalSelect.rows).toHaveLength(0);
    });
  });

  test("rejects invalid queries early", async () => {
    await withTestTransaction(async () => {
      await expect(queryDb("   ")).rejects.toThrow(/non-empty SQL query string/i);
      await expect(queryDb("SELECT $1::text", [undefined])).rejects.toThrow(
        /must not include undefined/i
      );
    });
  });
});
