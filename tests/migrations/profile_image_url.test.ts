import { newDb } from "pg-mem";
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

describe("20260424_add_users_profile_image_url migration", () => {
  it("adds nullable text profile_image_url and is safe to rerun", () => {
    const db = newDb();
    db.public.none("CREATE TABLE users (id uuid PRIMARY KEY);");

    const migrationPath = path.resolve(process.cwd(), "migrations/20260424_add_users_profile_image_url.sql");
    const sql = fs.readFileSync(migrationPath, "utf8");

    db.public.none(sql);
    db.public.none(sql);

    const [column] = db.public.many(`
      SELECT data_type
      FROM information_schema.columns
      WHERE table_name = 'users' AND column_name = 'profile_image_url'
    `);

    expect(column).toBeDefined();
    expect(column.data_type).toBe("text");

    expect(() =>
      db.public.none(
        "INSERT INTO users (id, profile_image_url) VALUES ('11111111-1111-4111-8111-111111111111', NULL)",
      ),
    ).not.toThrow();
  });
});
