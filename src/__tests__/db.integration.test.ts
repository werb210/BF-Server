import { getDb } from "../lib/db";

const shouldRun = process.env.DATABASE_URL;

(shouldRun ? test : test.skip)("db must connect", async () => {
  const res = await getDb().query("SELECT 1");
  expect(res).toBeTruthy();
});
