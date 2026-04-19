import { newDb } from "pg-mem";
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

describe("115_contacts_silo_index migration", () => {
  it("adds silo column with BF default", () => {
    const db = newDb();
    db.public.none("CREATE TABLE contacts (id uuid PRIMARY KEY);");

    const migrationPath = path.resolve(process.cwd(), "migrations/115_contacts_silo_index.sql");
    db.public.none(fs.readFileSync(migrationPath, "utf8"));

    db.public.none("INSERT INTO contacts (id) VALUES ('11111111-1111-4111-8111-111111111111')");
    const result = db.public.many("SELECT silo FROM contacts");
    expect(result[0].silo).toBe("BF");
  });
});
