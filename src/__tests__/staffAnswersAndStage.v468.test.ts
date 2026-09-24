// BF_SERVER_BLOCK_v468_STAFF_ANSWERS + BF_SERVER_BLOCK_v468_STAGE_AFTER_SEND
import { describe, it, expect } from "vitest";
import fs from "node:fs";

const routes = fs.readFileSync("src/modules/applications/applications.routes.ts", "utf8");
const portal = fs.readFileSync("src/routes/portal.ts", "utf8");
const migration = fs.readFileSync("migrations/2026_09_24_v468_sent_apps_off_to_lender.sql", "utf8");

describe("v468 staff can answer a blank product question", () => {
  it("no longer refuses a staff answer to an unanswered question", () => {
    expect(routes).not.toContain("only the client can answer an unanswered question");
  });
  it("still refuses an empty answer", () => {
    expect(routes).toContain("return res.status(400).json({ error: 'empty_answer', message: 'Choose an answer before saving.', ids: empty });");
  });
});

describe("v468 a sent application goes back to Off to Lender, not In Review", () => {
  it("documents-accepted checks for a package already sent", () => {
    expect(portal).toContain("FROM application_packages WHERE application_id::text = ($1)::text AND sent_at IS NOT NULL");
    expect(portal).toContain('const next = Number(sent.rows[0]?.n ?? 0) > 0 ? "Off to Lender" : "In Review";');
    expect(portal).toContain('await recordTransition(appId, cur, next, req.user?.userId ?? null, "All documents accepted");');
  });
  it("the backfill only moves Received / In Review files that were sent", () => {
    expect(migration).toContain("WHERE a.pipeline_state IN ('Received', 'In Review')");
    expect(migration).toContain("AND p.sent_at IS NOT NULL");
    expect(migration).not.toContain("Additional Steps Required',");
  });
});
