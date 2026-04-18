import { newDb } from "pg-mem";
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

describe("113_issues_table migration", () => {
  it("creates issues table and allows title/description-only inserts", async () => {
    const db = newDb();
    db.public.registerFunction({
      name: "gen_random_uuid",
      returns: "uuid" as any,
      implementation: () => "11111111-1111-4111-8111-111111111111",
    });

    db.public.none("CREATE TABLE contacts (id uuid PRIMARY KEY);");
    db.public.none("CREATE TABLE applications (id text PRIMARY KEY);");

    const migrationPath = path.resolve(process.cwd(), "migrations/113_issues_table.sql");
    const sql = fs.readFileSync(migrationPath, "utf8");
    db.public.none(sql);

    db.public.none("INSERT INTO issues (title, description) VALUES ('Portal bug', 'broken button')");

    const result = db.public.many(
      "SELECT title, description, status, screenshot_url, contact_id, application_id, submitted_by FROM issues",
    );

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      title: "Portal bug",
      description: "broken button",
      status: "open",
      screenshot_url: null,
      contact_id: null,
      application_id: null,
      submitted_by: null,
    });
  });
});
