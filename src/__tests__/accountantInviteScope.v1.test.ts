// BF_SERVER_ACCOUNTANT_INVITE_SCOPE_v1
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it, expect } from "vitest";

const surface = readFileSync(path.join(process.cwd(), "src/routes/accountant.ts"), "utf8");
const invite = readFileSync(path.join(process.cwd(), "src/services/accountantInvite.ts"), "utf8");
const capture = readFileSync(path.join(process.cwd(), "src/routes/client/accountant.ts"), "utf8");
const migration = readFileSync(
  path.join(process.cwd(), "migrations/2026_08_01_v2941_accountant_invites_business_name.sql"),
  "utf8"
);

describe("accountant invitation scope v1", () => {
  it("never scopes the accountant surface on applications.contact_id", () => {
    expect(surface).not.toContain("AND contact_id::text = ($2)::text");
    expect(surface).not.toContain("WHERE a.contact_id::text = ($1)::text");
  });
  it("scopes every accountant query through accountant_invites", () => {
    const joins = surface.match(/JOIN accountant_invites ai ON ai\.application_id::text = a\.id::text/g) ?? [];
    expect(joins.length).toBe(3);
    expect(surface).toContain("FROM accountant_invites ai");
    const scoped = surface.match(/ai\.contact_id::text = \(\$\d\)::text/g) ?? [];
    expect(scoped.length).toBe(4);
  });
  it("returns amount and date so two applications are told apart", () => {
    expect(surface).toContain("a.requested_amount");
    expect(surface).toContain("a.created_at");
  });
  it("persists the client-supplied business name and prefers it", () => {
    expect(migration).toContain("ADD COLUMN IF NOT EXISTS business_name TEXT");
    expect(invite).toContain("INSERT INTO accountant_invites (application_id, contact_id, email, business_name)");
    expect(invite).toContain("suppliedBusinessName ||");
    expect(capture).toContain('clean(req.body?.businessName)');
    expect(capture).toContain("businessName,");
  });
  it("keeps the lender-submission sender untouched", () => {
    expect(invite).toContain("ACCOUNTANT_INVITE_SEND_AS");
    expect(invite).not.toContain("process.env.MS_GRAPH_SEND_AS");
  });
});
