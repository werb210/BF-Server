import { describe, it, expect } from 'vitest';
import request from "supertest";
import { randomUUID } from "crypto";
import { buildAppWithApiRoutes } from "../app";
import { pool } from "../db";
import { createUserAccount } from "../modules/auth/auth.service";
import { ROLES } from "../auth/roles";
import { listDailyMetrics } from "../modules/reporting/dailyMetrics.service";
import { listApplicationVolume } from "../modules/reporting/applicationVolume.service";
import { listDocumentMetrics } from "../modules/reporting/documentMetrics.service";
import { listStaffActivity } from "../modules/reporting/staffActivity.service";
import {
  runApplicationVolumeJob,
  runDailyMetricsJob,
  runDailyPipelineSnapshotJob,
  runDocumentMetricsJob,
  runLenderFunnelJob,
  runLenderPerformanceJob,
  runPipelineSnapshotJob,
  runStaffActivityJob,
} from "../modules/reporting/reporting.jobs";
import { ensureAuditEventSchema } from "./helpers/auditSchema";
import { otpVerifyRequest } from "./helpers/otpAuth";

const app = buildAppWithApiRoutes();
const requestId = "test-request-id";
let idempotencyCounter = 0;
const nextIdempotencyKey = (): string => `idem-reporting-${idempotencyCounter++}`;
let phoneCounter = 900;
const nextPhone = (): string =>
  `+1415555${String(phoneCounter++).padStart(4, "0")}`;

async function resetDb(): Promise<void> {
  await pool.query("delete from reporting_lender_funnel_daily");
  await pool.query("delete from reporting_staff_activity_daily");
  await pool.query("delete from reporting_document_metrics_daily");
  await pool.query("delete from reporting_application_volume_daily");
  await pool.query("delete from reporting_pipeline_daily_snapshots");
  await pool.query("delete from reporting_lender_performance");
  await pool.query("delete from reporting_pipeline_snapshots");
  await pool.query("delete from reporting_daily_metrics");
  await pool.query("delete from client_submissions");
  await pool.query("delete from lender_submission_retries");
  await pool.query("delete from lender_submissions");
  await pool.query("delete from document_version_reviews");
  await pool.query("delete from document_versions");
  await pool.query("delete from documents");
  await pool.query("delete from applications");
  await pool.query("delete from idempotency_keys");
  await pool.query("delete from auth_refresh_tokens");
  await pool.query("delete from password_resets");
  await pool.query("delete from audit_events");
  await pool.query("delete from users where id <> '00000000-0000-0000-0000-000000000001'");
}

beforeAll(async () => {
  process.env.BUILD_TIMESTAMP = "2024-01-01T00:00:00.000Z";
  process.env.COMMIT_SHA = "test-commit";
  process.env.JWT_SECRET = "test-access-secret";
  process.env.LOGIN_LOCKOUT_THRESHOLD = "2";
  process.env.LOGIN_LOCKOUT_MINUTES = "10";
  process.env.PASSWORD_MAX_AGE_DAYS = "30";
  process.env.NODE_ENV = "test";
  await ensureAuditEventSchema();
});

beforeEach(async () => {
  await resetDb();
  idempotencyCounter = 0;
  phoneCounter = 900;
});

afterAll(async () => {
  await pool.end();
});

async function seedReportingData(): Promise<{ ownerId: string; staffId: string }> {
  const owner = await createUserAccount({
    email: "owner@reports.test",
    phoneNumber: nextPhone(),
    role: ROLES.REFERRER,
  });
  const staff = await createUserAccount({
    email: "staff@reports.test",
    phoneNumber: nextPhone(),
    role: ROLES.STAFF,
  });

  const baseDate = new Date("2024-02-01T10:00:00.000Z");
  const applicationIds = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
  const states = ["OFF_TO_LENDER", "ACCEPTED", "DECLINED", "STARTUP"];

  await Promise.all(
    applicationIds.map((id, index) =>
      pool.query(
        `insert into applications
         (id, owner_user_id, name, metadata, product_type, pipeline_state, created_at, updated_at)
         values ($1, $2, $3, $4, $5, $6, $7, $7)`,
        [
          id,
          owner.id,
          `App ${index}`,
          null,
          index % 2 === 0 ? "standard" : "express",
          states[index],
          baseDate,
        ]
      )
    )
  );

  const documentId = randomUUID();
  await pool.query(
    `insert into documents
     (id, application_id, owner_user_id, title, document_type, created_at)
     values ($1, $2, $3, $4, $5, $6)`,
    [documentId, applicationIds[0], owner.id, "Bank Statement", "bank_statement", baseDate]
  );

  const versionIds = [randomUUID(), randomUUID()];
  await pool.query(
    `insert into document_versions
     (id, document_id, version, metadata, content, created_at)
     values ($1, $2, $3, $4, $5, $6),
            ($7, $2, $8, $4, $9, $6)`,
    [
      versionIds[0],
      documentId,
      1,
      JSON.stringify({ file: "v1" }),
      "content1",
      baseDate,
      versionIds[1],
      2,
      "content2",
    ]
  );

  await pool.query(
    `insert into document_version_reviews
     (id, document_version_id, status, reviewed_by_user_id, reviewed_at)
     values ($1, $2, $3, $4, $5)`,
    [randomUUID(), versionIds[0], "accepted", staff.id, baseDate]
  );

  await pool.query(
    `insert into lender_submissions
     (id, application_id, status, idempotency_key, lender_id, submitted_at, payload, created_at, updated_at)
     values ($1, $2, $3, $4, $5, $6, $7, $6, $6)`,
    [
      randomUUID(),
      applicationIds[0],
      "submitted",
      randomUUID(),
      "lender-a",
      baseDate,
      JSON.stringify({}),
    ]
  );

  await pool.query(
    `insert into audit_events
     (id, actor_user_id, target_user_id, event_type, event_action, ip_address, user_agent, request_id, success, metadata, created_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [
      randomUUID(),
      staff.id,
      null,
      "reporting",
      "REPORT_VIEW",
      "127.0.0.1",
      "jest",
      "req-1",
      true,
      JSON.stringify({}),
      baseDate,
    ]
  );

  return { ownerId: owner.id, staffId: staff.id };
}

describe("reporting", () => {
  it("aggregates daily metrics correctly", async () => {
    await seedReportingData();
    const runDate = new Date("2024-02-01T05:00:00.000Z");
    await runDailyMetricsJob(runDate);

    const metrics = await listDailyMetrics({
      from: new Date("2024-02-01T00:00:00.000Z"),
      to: new Date("2024-02-02T00:00:00.000Z"),
      groupBy: "day",
      limit: 10,
      offset: 0,
    });

    expect(metrics).toHaveLength(1);
    expect(metrics[0]).toMatchObject({
      applicationsCreated: 4,
      applicationsSubmitted: 1,
      applicationsApproved: 1,
      applicationsDeclined: 1,
      applicationsFunded: 1,
      documentsUploaded: 2,
      documentsApproved: 1,
      lenderSubmissions: 1,
    });
  });

  it("aggregates volume, documents, and staff metrics", async () => {
    const { staffId } = await seedReportingData();
    const runDate = new Date("2024-02-01T05:00:00.000Z");

    await runApplicationVolumeJob(runDate);
    await runDocumentMetricsJob(runDate);
    await runStaffActivityJob(runDate);

    const volume = await listApplicationVolume({
      from: new Date("2024-02-01T00:00:00.000Z"),
      to: new Date("2024-02-02T00:00:00.000Z"),
      groupBy: "day",
      limit: 10,
      offset: 0,
    });
    const documents = await listDocumentMetrics({
      from: new Date("2024-02-01T00:00:00.000Z"),
      to: new Date("2024-02-02T00:00:00.000Z"),
      groupBy: "day",
      limit: 10,
      offset: 0,
    });
    const activity = await listStaffActivity({
      from: new Date("2024-02-01T00:00:00.000Z"),
      to: new Date("2024-02-02T00:00:00.000Z"),
      groupBy: "day",
      limit: 10,
      offset: 0,
      staffUserId: staffId,
    });

    expect(volume.length).toBeGreaterThan(0);
    expect(documents[0]).toMatchObject({
      documentType: "bank_statement",
      documentsUploaded: 2,
      documentsReviewed: 1,
      documentsApproved: 1,
    });
    expect(activity[0]).toMatchObject({
      staffUserId: staffId,
      action: "REPORT_VIEW",
      activityCount: 1,
    });
  });

  it("enforces reporting access roles", async () => {
    const userPhone = nextPhone();
    const adminPhone = nextPhone();
    await createUserAccount({
      email: "user@reports.test",
      phoneNumber: userPhone,
      role: ROLES.REFERRER,
    });
    await createUserAccount({
      email: "admin@reports.test",
      phoneNumber: adminPhone,
      role: ROLES.ADMIN,
    });

    const userLogin = await otpVerifyRequest(app, {
      phone: userPhone,
      requestId,
      idempotencyKey: nextIdempotencyKey(),
    });
    const adminLogin = await otpVerifyRequest(app, {
      phone: adminPhone,
      requestId,
      idempotencyKey: nextIdempotencyKey(),
    });

    const forbidden = await request(app)
      .get("/api/reporting/applications/volume")
      .set("Authorization", `Bearer ${userLogin.body.accessToken}`);
    expect(forbidden.status).toBe(403);

    const allowed = await request(app)
      .get("/api/reporting/applications/volume")
      .set("Authorization", `Bearer ${adminLogin.body.accessToken}`);
    expect(allowed.status).toBe(200);
  });

  it("runs reporting jobs idempotently", async () => {
    await seedReportingData();
    const runDate = new Date("2024-02-01T05:00:00.000Z");
    const lenderRunDate = new Date("2024-02-02T05:00:00.000Z");

    await runDailyMetricsJob(runDate);
    await runDailyMetricsJob(runDate);

    const dailyCount = await pool.query<{ count: string }>(
      "select count(*) from reporting_daily_metrics where metric_date = $1",
      ["2024-02-01"]
    );
    expect(Number(dailyCount.rows[0].count)).toBe(1);

    await runPipelineSnapshotJob(runDate);
    await runPipelineSnapshotJob(runDate);

    const expectedSnapshots = await pool.query<{ count: string }>(
      "select count(distinct pipeline_state) from applications"
    );
    const snapshotCount = await pool.query<{ count: string }>(
      "select count(*) from reporting_pipeline_snapshots where snapshot_at = $1",
      ["2024-02-01T05:00:00.000Z"]
    );
    expect(Number(snapshotCount.rows[0].count)).toBe(
      Number(expectedSnapshots.rows[0].count)
    );

    await runDailyPipelineSnapshotJob(runDate);
    await runDailyPipelineSnapshotJob(runDate);

    const dailySnapshotCount = await pool.query<{ count: string }>(
      "select count(*) from reporting_pipeline_daily_snapshots where snapshot_date = $1",
      ["2024-02-01"]
    );
    expect(Number(dailySnapshotCount.rows[0].count)).toBe(
      Number(expectedSnapshots.rows[0].count)
    );

    await runLenderPerformanceJob(lenderRunDate);
    await runLenderPerformanceJob(lenderRunDate);

    const lenderCount = await pool.query<{ count: string }>(
      "select count(*) from reporting_lender_performance where period_start = $1 and lender_id = $2",
      ["2024-02-01", "lender-a"]
    );
    expect(Number(lenderCount.rows[0].count)).toBe(1);

    await runApplicationVolumeJob(runDate);
    await runApplicationVolumeJob(runDate);

    const volumeCount = await pool.query<{ count: string }>(
      "select count(*) from reporting_application_volume_daily where metric_date = $1",
      ["2024-02-01"]
    );
    expect(Number(volumeCount.rows[0].count)).toBeGreaterThan(0);

    await runDocumentMetricsJob(runDate);
    await runDocumentMetricsJob(runDate);

    const documentCount = await pool.query<{ count: string }>(
      "select count(*) from reporting_document_metrics_daily where metric_date = $1",
      ["2024-02-01"]
    );
    expect(Number(documentCount.rows[0].count)).toBeGreaterThan(0);

    await runStaffActivityJob(runDate);
    await runStaffActivityJob(runDate);

    const staffCount = await pool.query<{ count: string }>(
      "select count(*) from reporting_staff_activity_daily where metric_date = $1",
      ["2024-02-01"]
    );
    expect(Number(staffCount.rows[0].count)).toBe(1);

    await runLenderFunnelJob(runDate);
    await runLenderFunnelJob(runDate);

    const funnelCount = await pool.query<{ count: string }>(
      "select count(*) from reporting_lender_funnel_daily where metric_date = $1 and lender_id = $2",
      ["2024-02-01", "lender-a"]
    );
    expect(Number(funnelCount.rows[0].count)).toBe(1);
  });

  it("handles date boundaries correctly", async () => {
    const { ownerId } = await seedReportingData();
    const boundaryStart = new Date("2024-02-03T00:00:00.000Z");
    const boundaryEnd = new Date("2024-02-04T00:00:00.000Z");

    await pool.query(
      `insert into applications
       (id, owner_user_id, name, metadata, product_type, pipeline_state, created_at, updated_at)
       values ($1, $2, $3, $4, $5, $6, $7, $7)`,
      [randomUUID(), ownerId, "Boundary App", null, "standard", "ACCEPTED", boundaryEnd]
    );

    await runDailyMetricsJob(boundaryStart);

    const metrics = await listDailyMetrics({
      from: boundaryStart,
      to: boundaryEnd,
      groupBy: "day",
      limit: 10,
      offset: 0,
    });

    const totalCreated = metrics.reduce(
      (sum, row) => sum + row.applicationsCreated,
      0
    );
    expect(totalCreated).toBe(0);
  });

  it("does not write to transactional tables during jobs", async () => {
    await seedReportingData();

    const countsBefore = await Promise.all([
      pool.query("select count(*) from applications"),
      pool.query("select count(*) from documents"),
      pool.query("select count(*) from document_versions"),
      pool.query("select count(*) from document_version_reviews"),
      pool.query("select count(*) from lender_submissions"),
    ]);

    await runDailyMetricsJob(new Date("2024-02-02T05:00:00.000Z"));
    await runPipelineSnapshotJob(new Date("2024-02-02T05:00:00.000Z"));
    await runLenderPerformanceJob(new Date("2024-02-02T05:00:00.000Z"));

    const countsAfter = await Promise.all([
      pool.query("select count(*) from applications"),
      pool.query("select count(*) from documents"),
      pool.query("select count(*) from document_versions"),
      pool.query("select count(*) from document_version_reviews"),
      pool.query("select count(*) from lender_submissions"),
    ]);

    countsBefore.forEach((before, index) => {
      expect(before.rows[0].count).toBe(countsAfter[index].rows[0].count);
    });
  });
});
