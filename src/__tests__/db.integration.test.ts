import { queryDb } from "../lib/db";

test("db executes real queries", async () => {
  await queryDb(`INSERT INTO health_check (status) VALUES ('ok')`);

  const res = await queryDb(`SELECT * FROM health_check`);

  expect(res.rows.length).toBe(1);
  expect(res.rows[0].status).toBe("ok");
});
