// BF_SERVER_WATCH_CALLBACKS_v216
import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";

const routes = readFileSync("src/watch/dataRoutes.ts", "utf-8");
const block = routes.slice(routes.indexOf("BF_SERVER_WATCH_CALLBACKS_v216"));
const migrations = readdirSync("migrations")
  .map((f) => readFileSync(`migrations/${f}`, "utf-8"))
  .join("\n");

describe("what counts as a callback", () => {
  it("only lists tasks with a contact who has a phone number", () => {
    // A task with nobody to ring is a to-do. Counting it makes the number lie.
    expect(block).toContain("JOIN contacts c ON c.id = t.contact_id");
    expect(block).toContain("COALESCE(NULLIF(TRIM(c.phone), ''), NULL) IS NOT NULL");
  });

  it("includes overdue calls rather than hiding them", () => {
    expect(block).toContain("t.due_at < date_trunc('day', now()) + interval '1 day'");
    expect(block).toContain('(t.due_at < now()) AS overdue');
  });

  it("puts the most overdue first", () => {
    expect(block).toContain("ORDER BY t.due_at ASC");
  });

  it("returns the number, so the watch can dial without another call", () => {
    expect(block).toContain("c.phone           AS number");
  });
});

describe("it targets the live schema", () => {
  it("reads tasks, not the retired crm_tasks", () => {
    expect(block).toContain("FROM tasks t");
    expect(block).not.toContain("crm_tasks");
  });

  it("uses only columns tasks and contacts actually have", () => {
    expect(migrations).toContain("assignee_user_id");
    expect(migrations).toMatch(/CREATE TABLE IF NOT EXISTS contacts[\s\S]{0,400}phone text/);
    expect(block).toContain("t.assignee_user_id = $1::uuid");
  });

  it("uses status values the CHECK constraint permits", () => {
    for (const s of ["COMPLETED", "DEFERRED"]) {
      expect(migrations).toContain(`'${s}'`);
      expect(block).toContain(`'${s}'`);
    }
  });
});

describe("it cannot fail silently", () => {
  it("logs rather than swallowing, so a schema slip is visible", () => {
    expect(block).toMatch(/\.catch\(\(err: any\) => \{[\s\S]{0,200}console\.error/);
  });

  it("scopes to one silo and the signed-in staff user", () => {
    expect(block).toContain("t.silo = $2");
    expect(block).toContain("allowedLine(req, requested)");
  });

  it("bounds the result set", () => {
    expect(block).toContain("bounded(req.query.limit, 20, 50)");
  });
});
