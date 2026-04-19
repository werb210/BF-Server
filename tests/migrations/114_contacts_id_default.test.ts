import { newDb } from "pg-mem";
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

describe("114_contacts_id_default migration", () => {
  it("sets contacts.id default uuid and prevents null ids", () => {
    const db = newDb();
    db.public.registerFunction({
      name: "gen_random_uuid",
      returns: "uuid" as any,
      implementation: () => "11111111-1111-4111-8111-111111111111",
    });

    db.public.none("CREATE TABLE users (id uuid PRIMARY KEY);");
    db.public.none("CREATE TABLE contacts (id uuid PRIMARY KEY, name text);");

    const migrationPath = path.resolve(process.cwd(), "migrations/114_contacts_id_default.sql");
    db.public.none(fs.readFileSync(migrationPath, "utf8"));

    db.public.none("INSERT INTO contacts (name) VALUES ('Alice')");

    const result = db.public.many("SELECT id, user_id FROM contacts");
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("11111111-1111-4111-8111-111111111111");
    expect(result[0].user_id).toBeNull();
  });
});
