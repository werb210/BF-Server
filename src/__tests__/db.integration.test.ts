import { getDb } from "../lib/db";

test("db must connect", async () => {
  const res = await getDb().query("SELECT 1");
  expect(res).toBeTruthy();
});
