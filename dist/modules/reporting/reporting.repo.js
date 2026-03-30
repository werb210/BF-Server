"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.upsertDailyMetrics = upsertDailyMetrics;
exports.upsertDailyMetricsWindow = upsertDailyMetricsWindow;
exports.upsertPipelineSnapshot = upsertPipelineSnapshot;
exports.upsertPipelineSnapshotAt = upsertPipelineSnapshotAt;
exports.upsertPipelineDailySnapshot = upsertPipelineDailySnapshot;
exports.upsertLenderPerformance = upsertLenderPerformance;
exports.upsertLenderPerformanceWindow = upsertLenderPerformanceWindow;
exports.upsertApplicationVolumeWindow = upsertApplicationVolumeWindow;
exports.upsertDocumentMetricsWindow = upsertDocumentMetricsWindow;
exports.upsertStaffActivityWindow = upsertStaffActivityWindow;
exports.upsertLenderFunnelWindow = upsertLenderFunnelWindow;
const crypto_1 = require("crypto");
const db_1 = require("../../db");
async function upsertDailyMetrics(params) {
    const runner = params.client ?? db_1.pool;
    const result = await runner.query(`insert into reporting_daily_metrics
     (id, metric_date, applications_created, applications_submitted, applications_approved, applications_declined,
      applications_funded, documents_uploaded, documents_approved, lender_submissions, created_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, now())
     on conflict (metric_date) do update
     set applications_created = excluded.applications_created,
         applications_submitted = excluded.applications_submitted,
         applications_approved = excluded.applications_approved,
         applications_declined = excluded.applications_declined,
         applications_funded = excluded.applications_funded,
         documents_uploaded = excluded.documents_uploaded,
         documents_approved = excluded.documents_approved,
         lender_submissions = excluded.lender_submissions`, [
        (0, crypto_1.randomUUID)(),
        params.metricDate,
        params.applicationsCreated,
        params.applicationsSubmitted,
        params.applicationsApproved,
        params.applicationsDeclined,
        params.applicationsFunded,
        params.documentsUploaded,
        params.documentsApproved,
        params.lenderSubmissions,
    ]);
    return result.rowCount ?? 0;
}
async function upsertDailyMetricsWindow(params) {
    const runner = params.client ?? db_1.pool;
    const result = await runner.query(`insert into reporting_daily_metrics
     (id, metric_date, applications_created, applications_submitted, applications_approved, applications_declined,
      applications_funded, documents_uploaded, documents_approved, lender_submissions, created_at)
     select
       'daily:' || $1::text,
       $1::date,
       count(*) filter (where created_at >= $1 and created_at < $2)::int as applications_created,
       count(*) filter (where pipeline_state = 'OFF_TO_LENDER' and updated_at >= $1 and updated_at < $2)::int as applications_submitted,
       count(*) filter (where pipeline_state = 'ACCEPTED' and updated_at >= $1 and updated_at < $2)::int as applications_approved,
       count(*) filter (where pipeline_state = 'REJECTED' and updated_at >= $1 and updated_at < $2)::int as applications_declined,
       count(*) filter (where pipeline_state = 'ACCEPTED' and updated_at >= $1 and updated_at < $2)::int as applications_funded,
       (select count(*)::int from document_versions where created_at >= $1 and created_at < $2) as documents_uploaded,
       (select count(*)::int from document_version_reviews where status = 'accepted' and reviewed_at >= $1 and reviewed_at < $2) as documents_approved,
       (select count(*)::int from lender_submissions where created_at >= $1 and created_at < $2) as lender_submissions,
       $3::timestamp
     from applications
     where (created_at >= $1 and created_at < $2)
        or (updated_at >= $1 and updated_at < $2)
     on conflict (metric_date) do update
     set applications_created = excluded.applications_created,
         applications_submitted = excluded.applications_submitted,
         applications_approved = excluded.applications_approved,
         applications_declined = excluded.applications_declined,
         applications_funded = excluded.applications_funded,
         documents_uploaded = excluded.documents_uploaded,
         documents_approved = excluded.documents_approved,
         lender_submissions = excluded.lender_submissions`, [params.start, params.end, params.createdAt]);
    return result.rowCount ?? 0;
}
async function upsertPipelineSnapshot(params) {
    const runner = params.client ?? db_1.pool;
    const result = await runner.query(`insert into reporting_pipeline_snapshots
     (id, snapshot_at, pipeline_state, application_count)
     values ($1, $2, $3, $4)
     on conflict (snapshot_at, pipeline_state) do update
     set application_count = excluded.application_count`, [(0, crypto_1.randomUUID)(), params.snapshotAt, params.pipelineState, params.applicationCount]);
    return result.rowCount ?? 0;
}
async function upsertPipelineSnapshotAt(params) {
    const runner = params.client ?? db_1.pool;
    const result = await runner.query(`insert into reporting_pipeline_snapshots
     (id, snapshot_at, pipeline_state, application_count)
     select
       pipeline_state || ':' || $1::text,
       $1::timestamp,
       pipeline_state,
       count(*)::int
     from applications
     group by pipeline_state
     on conflict (snapshot_at, pipeline_state) do update
     set application_count = excluded.application_count`, [params.snapshotAt]);
    return result.rowCount ?? 0;
}
async function upsertPipelineDailySnapshot(params) {
    const runner = params.client ?? db_1.pool;
    const result = await runner.query(`insert into reporting_pipeline_daily_snapshots
     (id, snapshot_date, pipeline_state, application_count, created_at)
     select
       pipeline_state || ':' || $1::text,
       $1::date,
       pipeline_state,
       count(*)::int,
       $2::timestamp
     from applications
     group by pipeline_state
     on conflict (snapshot_date, pipeline_state) do update
     set application_count = excluded.application_count`, [params.snapshotDate, params.createdAt]);
    return result.rowCount ?? 0;
}
async function upsertLenderPerformance(params) {
    const runner = params.client ?? db_1.pool;
    const result = await runner.query(`insert into reporting_lender_performance
     (id, lender_id, period_start, period_end, submissions, approvals, declines, funded, avg_decision_time_seconds, created_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, now())
     on conflict (lender_id, period_start, period_end) do update
     set submissions = excluded.submissions,
         approvals = excluded.approvals,
         declines = excluded.declines,
         funded = excluded.funded,
         avg_decision_time_seconds = excluded.avg_decision_time_seconds`, [
        (0, crypto_1.randomUUID)(),
        params.lenderId,
        params.periodStart,
        params.periodEnd,
        params.submissions,
        params.approvals,
        params.declines,
        params.funded,
        params.avgDecisionTimeSeconds,
    ]);
    return result.rowCount ?? 0;
}
async function upsertLenderPerformanceWindow(params) {
    const runner = params.client ?? db_1.pool;
    const result = await runner.query(`insert into reporting_lender_performance
     (id, lender_id, period_start, period_end, submissions, approvals, declines, funded, avg_decision_time_seconds, created_at)
     select
       ls.lender_id || ':' || $1::text || ':' || $2::text,
       ls.lender_id,
       $1::date,
       $2::date,
       count(*)::int as submissions,
       sum(case when a.pipeline_state = 'ACCEPTED' then 1 else 0 end)::int as approvals,
       sum(case when a.pipeline_state = 'REJECTED' then 1 else 0 end)::int as declines,
       sum(case when a.pipeline_state = 'ACCEPTED' then 1 else 0 end)::int as funded,
       coalesce(
         avg(
           case
             when a.pipeline_state in ('ACCEPTED', 'REJECTED')
               and ls.submitted_at is not null
             then extract(epoch from (a.updated_at - ls.submitted_at))
             else null
           end
         ),
         0
       )::int,
       $3::timestamp
     from lender_submissions ls
     join applications a on a.id = ls.application_id
     where ls.created_at >= $1
       and ls.created_at < $2
     group by ls.lender_id
     on conflict (lender_id, period_start, period_end) do update
     set submissions = excluded.submissions,
         approvals = excluded.approvals,
         declines = excluded.declines,
         funded = excluded.funded,
         avg_decision_time_seconds = excluded.avg_decision_time_seconds`, [params.periodStart, params.periodEnd, params.createdAt]);
    return result.rowCount ?? 0;
}
async function upsertApplicationVolumeWindow(params) {
    const runner = params.client ?? db_1.pool;
    const result = await runner.query(`insert into reporting_application_volume_daily
     (id, metric_date, product_type, applications_created, applications_submitted, applications_approved, applications_declined, applications_funded, created_at)
     select
       a.product_type || ':' || $1::text,
       $1::date,
       a.product_type,
       sum(case when a.created_at >= $1 and a.created_at < $2 then 1 else 0 end)::int,
       sum(case when a.pipeline_state = 'OFF_TO_LENDER' and a.updated_at >= $1 and a.updated_at < $2 then 1 else 0 end)::int,
       sum(case when a.pipeline_state = 'ACCEPTED' and a.updated_at >= $1 and a.updated_at < $2 then 1 else 0 end)::int,
       sum(case when a.pipeline_state = 'REJECTED' and a.updated_at >= $1 and a.updated_at < $2 then 1 else 0 end)::int,
       sum(case when a.pipeline_state = 'ACCEPTED' and a.updated_at >= $1 and a.updated_at < $2 then 1 else 0 end)::int,
       $3::timestamp
     from applications a
     where (a.created_at >= $1 and a.created_at < $2)
        or (a.updated_at >= $1 and a.updated_at < $2)
     group by a.product_type
     on conflict (metric_date, product_type) do update
     set applications_created = excluded.applications_created,
         applications_submitted = excluded.applications_submitted,
         applications_approved = excluded.applications_approved,
         applications_declined = excluded.applications_declined,
         applications_funded = excluded.applications_funded`, [params.start, params.end, params.createdAt]);
    return result.rowCount ?? 0;
}
async function upsertDocumentMetricsWindow(params) {
    const runner = params.client ?? db_1.pool;
    const result = await runner.query(`insert into reporting_document_metrics_daily
     (id, metric_date, document_type, documents_uploaded, documents_reviewed, documents_approved, created_at)
     select
       document_type || ':' || $1::text,
       $1::date,
       document_type,
       documents_uploaded,
       documents_reviewed,
       documents_approved,
       $3::timestamp
     from (
       select
         document_type,
         sum(documents_uploaded)::int as documents_uploaded,
         sum(documents_reviewed)::int as documents_reviewed,
         sum(documents_approved)::int as documents_approved
       from (
         select d.document_type as document_type,
                count(*)::int as documents_uploaded,
                0::int as documents_reviewed,
                0::int as documents_approved
         from document_versions dv
         join documents d on d.id = dv.document_id
         where dv.created_at >= $1 and dv.created_at < $2
         group by d.document_type
         union all
         select d.document_type as document_type,
                0::int as documents_uploaded,
                count(*)::int as documents_reviewed,
                count(*) filter (where r.status = 'accepted')::int as documents_approved
         from document_version_reviews r
         join document_versions dv on dv.id = r.document_version_id
         join documents d on d.id = dv.document_id
         where r.reviewed_at >= $1 and r.reviewed_at < $2
         group by d.document_type
       ) combined
       group by document_type
     ) aggregated
     on conflict (metric_date, document_type) do update
     set documents_uploaded = excluded.documents_uploaded,
         documents_reviewed = excluded.documents_reviewed,
         documents_approved = excluded.documents_approved`, [params.start, params.end, params.createdAt]);
    return result.rowCount ?? 0;
}
async function upsertStaffActivityWindow(params) {
    const runner = params.client ?? db_1.pool;
    const result = await runner.query(`insert into reporting_staff_activity_daily
     (id, metric_date, staff_user_id, action, activity_count, created_at)
     select
       ae.actor_user_id || ':' || ae.event_action || ':' || $1::text,
       $1::date,
       ae.actor_user_id,
       ae.event_action,
       count(*)::int,
       $3::timestamp
     from audit_events ae
     join users u on u.id = ae.actor_user_id
     where ae.actor_user_id is not null
       and u.role in ('Admin', 'Staff')
       and ae.created_at >= $1 and ae.created_at < $2
     group by ae.actor_user_id, ae.event_action
     on conflict (metric_date, staff_user_id, action) do update
     set activity_count = excluded.activity_count`, [params.start, params.end, params.createdAt]);
    return result.rowCount ?? 0;
}
async function upsertLenderFunnelWindow(params) {
    const runner = params.client ?? db_1.pool;
    const result = await runner.query(`insert into reporting_lender_funnel_daily
     (id, metric_date, lender_id, submissions, approvals, funded, created_at)
     select
       ls.lender_id || ':' || $1::text,
       $1::date,
       ls.lender_id,
       count(*)::int as submissions,
       count(*) filter (where a.pipeline_state = 'ACCEPTED')::int as approvals,
       count(*) filter (where a.pipeline_state = 'ACCEPTED')::int as funded,
       $3::timestamp
     from lender_submissions ls
     join applications a on a.id = ls.application_id
     where ls.created_at >= $1 and ls.created_at < $2
     group by ls.lender_id
     on conflict (metric_date, lender_id) do update
     set submissions = excluded.submissions,
         approvals = excluded.approvals,
         funded = excluded.funded`, [params.start, params.end, params.createdAt]);
    return result.rowCount ?? 0;
}
