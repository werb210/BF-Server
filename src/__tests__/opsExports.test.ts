import { describe, it, expect } from 'vitest';
import request from "supertest";
import { buildAppWithApiRoutes } from "../app";
import { pool } from "../db";
import { createUserAccount } from "../modules/auth/auth.service";
import { ROLES } from "../auth/roles";
import { recordAuditEvent } from "../modules/audit/audit.service";
import { ensureAuditEventSchema } from "./helpers/auditSchema";
import { otpVerifyRequest } from "./helpers/otpAuth";

const app = buildAppWithApiRoutes();
const requestId = "test-request-id";
let idempotencyCounter = 0;
const nextIdempotencyKey = (): string => `idem-ops-${idempotencyCounter++}`;
let phoneCounter = 1000;
const nextPhone = (): string =>
  `+1415555${String(phoneCounter++).padStart(4, "0")}`;

async function resetDb(): Promise<void> {
  await pool.query("delete from ops_replay_events");
  await pool.query("delete from ops_replay_jobs");
  await pool.query("delete from ops_kill_switches");
  await pool.query("delete from export_audit");
  await pool.query("delete from reporting_pipeline_daily_snapshots");
  await pool.query("delete from reporting_daily_metrics");
  await pool.query("delete from lender_submission_retries");
  await pool.query("delete from lender_submissions");
  await pool.query("delete from document_version_reviews");
  await pool.query("delete from document_versions");
  await pool.query("delete from documents");
  await pool.query("delete from applications");
  await pool.query("delete from idempotency_keys");
  await pool.query("delete from otp_verifications");
  await pool.query("delete from auth_refresh_tokens");
  await pool.query("delete from password_resets");
  await pool.query("delete from audit_events");
  await pool.query("delete from users where id <> '00000000-0000-0000-0000-000000000001'");
}

async function waitForJobCompletion(jobId: string): Promise<string> {
  for (let i = 0; i < 50; i += 1) {
    const result = await pool.query<{ status: string }>(
      "select status from ops_replay_jobs where id = $1",
      [jobId]
    );
    const status = result.rows[0]?.status;
    if (status && status !== "queued" && status !== "running") {
      return status;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("replay_job_timeout");
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
  idempotencyCounter = 0;
  phoneCounter = 1000;
});

afterAll(async () => {
  await pool.end();
});

describe("ops + exports", () => {
  it("enforces admin-only access for ops routes", async () => {
    const staffPhone = nextPhone();
    await createUserAccount({
      email: "staff@example.com",
      phoneNumber: staffPhone,
      role: ROLES.STAFF,
    });

    const login = await otpVerifyRequest(app, {
      phone: staffPhone,
      requestId,
      idempotencyKey: nextIdempotencyKey(),
    });

    const res = await request(app)
      .get("/api/admin/ops/kill-switches")
      .set("Authorization", `Bearer ${login.body.accessToken}`)
      .set("x-request-id", requestId);

    expect(res.status).toBe(403);
    expect(res.body.code).toBe("forbidden");
  });

  it("enforces kill switch before exports", async () => {
    const adminPhone = nextPhone();
    await createUserAccount({
      email: "admin-exports@example.com",
      phoneNumber: adminPhone,
      role: ROLES.ADMIN,
    });
    const login = await otpVerifyRequest(app, {
      phone: adminPhone,
      requestId,
      idempotencyKey: nextIdempotencyKey(),
    });

    await pool.query(
      "insert into ops_kill_switches (key, enabled, updated_at) values ($1, true, now())",
      ["exports"]
    );

    const res = await request(app)
      .post("/api/admin/exports/pipeline")
      .set("Idempotency-Key", nextIdempotencyKey())
      .set("Authorization", `Bearer ${login.body.accessToken}`)
      .set("x-request-id", requestId)
      .send({ format: "json" });

    expect(res.status).toBe(423);
    expect(res.body.code).toBe("ops_kill_switch");

    const audit = await pool.query("select count(*)::int as count from export_audit");
    expect(audit.rows[0].count).toBe(0);
  });

  it("streams CSV exports", async () => {
    const adminPhone = nextPhone();
    await createUserAccount({
      email: "admin-csv@example.com",
      phoneNumber: adminPhone,
      role: ROLES.ADMIN,
    });
    const login = await otpVerifyRequest(app, {
      phone: adminPhone,
      requestId,
      idempotencyKey: nextIdempotencyKey(),
    });

    await pool.query(
      `insert into reporting_pipeline_daily_snapshots
       (id, snapshot_date, pipeline_state, application_count, created_at)
       values ($1, $2, $3, $4, now())`,
      ["snap-1", new Date("2024-01-05"), "IN_REVIEW", 5]
    );

    const res = await request(app)
      .post("/api/admin/exports/pipeline")
      .set("Idempotency-Key", nextIdempotencyKey())
      .set("Authorization", `Bearer ${login.body.accessToken}`)
      .set("x-request-id", requestId)
      .send({ format: "csv" });

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("text/csv");
    expect(res.headers["transfer-encoding"]).toBe("chunked");
    expect(res.text.split("\n")[0]).toBe(
      "snapshot_date,pipeline_state,application_count"
    );
  });

  it("replay jobs are idempotent", async () => {
    const adminPhone = nextPhone();
    const admin = await createUserAccount({
      email: "admin-replay@example.com",
      phoneNumber: adminPhone,
      role: ROLES.ADMIN,
    });
    const login = await otpVerifyRequest(app, {
      phone: adminPhone,
      requestId,
      idempotencyKey: nextIdempotencyKey(),
    });

    await recordAuditEvent({
      actorUserId: admin.id,
      targetUserId: null,
      action: "test_event",
      success: true,
    });
    await recordAuditEvent({
      actorUserId: admin.id,
      targetUserId: null,
      action: "test_event_two",
      success: true,
    });
    const targetIdsResult = await pool.query<{ id: string }>(
      "select id from audit_events where event_action in ($1, $2)",
      ["test_event", "test_event_two"]
    );
    const targetIds = targetIdsResult.rows.map((row) => row.id);

    const first = await request(app)
      .post("/api/admin/ops/replay/audit_events")
      .set("Idempotency-Key", nextIdempotencyKey())
      .set("Authorization", `Bearer ${login.body.accessToken}`)
      .set("x-request-id", requestId);
    const firstJobId = first.body.job.id;
    const firstStatus = await waitForJobCompletion(firstJobId);
    expect(firstStatus).toBe("completed");

    const countAfterFirst = await pool.query(
      "select count(*)::int as count from ops_replay_events where source_table = 'audit_events' and source_id = any($1)",
      [targetIds]
    );

    const second = await request(app)
      .post("/api/admin/ops/replay/audit_events")
      .set("Idempotency-Key", nextIdempotencyKey())
      .set("Authorization", `Bearer ${login.body.accessToken}`)
      .set("x-request-id", requestId);
    const secondJobId = second.body.job.id;
    const secondStatus = await waitForJobCompletion(secondJobId);
    expect(secondStatus).toBe("completed");

    const countAfterSecond = await pool.query(
      "select count(*)::int as count from ops_replay_events where source_table = 'audit_events' and source_id = any($1)",
      [targetIds]
    );

    expect(countAfterFirst.rows[0].count).toBe(targetIds.length);
    expect(countAfterSecond.rows[0].count).toBe(targetIds.length);
  });
});
