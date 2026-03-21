import { describe, it, expect } from 'vitest';
import { pool } from "../db";
import { recordAuditEvent } from "../modules/audit/audit.service";
import { ensureAuditEventSchema } from "./helpers/auditSchema";

async function resetDb(): Promise<void> {
  await pool.query("delete from audit_events");
}

beforeAll(async () => {
  process.env.BUILD_TIMESTAMP = "2024-01-01T00:00:00.000Z";
  process.env.COMMIT_SHA = "test-commit";
  process.env.JWT_SECRET = "test-access-secret";
  process.env.NODE_ENV = "test";
  await ensureAuditEventSchema();
});

beforeEach(async () => {
  await resetDb();
});

afterAll(async () => {
  await pool.end();
});

describe("audit contract", () => {
  it("inserts audit rows with schema-aligned columns", async () => {
    await recordAuditEvent({
      actorUserId: null,
      targetUserId: null,
      action: "contract_check",
      ip: "127.0.0.1",
      userAgent: "jest",
      requestId: "req-123",
      success: true,
      metadata: { source: "contract" },
    });

    const result = await pool.query<{
      event_type: string | null;
      event_action: string | null;
      ip_address: string | null;
      user_agent: string | null;
      request_id: string | null;
      success: boolean;
    }>(
      `select event_type, event_action, ip_address, user_agent, request_id, success
       from audit_events`
    );

    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({
      event_type: "contract_check",
      event_action: "contract_check",
      ip_address: "127.0.0.1",
      user_agent: "jest",
      request_id: "req-123",
      success: true,
    });
  });
});
