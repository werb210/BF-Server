import { describe, it, expect } from 'vitest';
import { pool } from "../db";
import { createUserAccount } from "../modules/auth/auth.service";
import { ROLES } from "../auth/roles";

async function resetDb(): Promise<void> {
  await pool.query("delete from users");
}

beforeAll(() => {
  process.env.JWT_SECRET = "test-access-secret";
  process.env.NODE_ENV = "test";
});

beforeEach(async () => {
  await resetDb();
});

afterAll(async () => {
  await pool.end();
});

describe("user status enum validation", () => {
  it("rejects disabled as a status value", async () => {
    const user = await createUserAccount({
      phoneNumber: "+14155550001",
      role: ROLES.STAFF,
    });

    await expect(
      pool.query("update users set status = 'disabled' where id = $1", [user.id])
    ).rejects.toThrow();
  });
});
