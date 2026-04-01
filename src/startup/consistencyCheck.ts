import { config } from "../config";
import { pool } from "../db";
import { isTestEnvironment } from "../dbRuntime";
import { logError, logInfo, logWarn } from "../observability/logger";
import { PIPELINE_STATES } from "../modules/applications/pipelineState";

type SampleRow = Record<string, string>;

async function logCheckResult(params: {
  event: string;
  count: number;
  sample: SampleRow[];
}): Promise<void> {
  if (params.count > 0) {
    logWarn(params.event, { count: params.count, sample: params.sample });
    return;
  }
  logInfo(params.event, { count: params.count });
}

async function hasTable(table: string): Promise<boolean> {
  const res = await pool.runQuery<{ count: number }>(
    `select count(*)::int as count
     from information_schema.tables
     where table_name = $1`,
    [table]
  );
  return (res.rows[0]?.count ?? 0) > 0;
}

async function hasColumn(table: string, column: string): Promise<boolean> {
  const res = await pool.runQuery<{ count: number }>(
    `select count(*)::int as count
     from information_schema.columns
     where table_name = $1
       and column_name = $2`,
    [table, column]
  );
  return (res.rows[0]?.count ?? 0) > 0;
}

export async function runStartupConsistencyCheck(): Promise<void> {
  if (config.env === "test") {
    return;
  }
  try {
    const hasDocuments = await hasTable("documents");
    const hasApplications = await hasTable("applications");
    const hasDocumentApplicationId = await hasColumn("documents", "application_id");
    if (!hasDocuments || !hasApplications || !hasDocumentApplicationId) {
      logInfo("startup_orphaned_documents_skipped", {
        reason: "missing_documents_or_applications",
      });
    } else {
      const orphanDocumentsCount = await pool.runQuery<{ count: number }>(
        `select count(*)::int as count
         from documents d
         where not exists (
           select 1 from applications a where a.id = d.application_id
         )`
      );
      const orphanDocumentsSample = await pool.runQuery<SampleRow>(
        `select d.id, d.application_id
         from documents d
         where not exists (
           select 1 from applications a where a.id = d.application_id
         )
         limit 10`
      );
      await logCheckResult({
        event: "startup_orphaned_documents",
        count: orphanDocumentsCount.rows[0]?.count ?? 0,
        sample: orphanDocumentsSample.rows,
      });
    }

    const hasUsers = await hasTable("users");
    const hasOwnerUserId = await hasColumn("applications", "owner_user_id");
    if (!hasApplications || !hasUsers || !hasOwnerUserId) {
      logInfo("startup_orphaned_applications_skipped", {
        reason: "missing_applications_users_or_owner",
      });
    } else {
      const orphanApplicationsCount = await pool.runQuery<{ count: number }>(
        `select count(*)::int as count
         from applications a
         where not exists (
           select 1 from users u where u.id = a.owner_user_id
         )`
      );
      const orphanApplicationsSample = await pool.runQuery<SampleRow>(
        `select a.id, a.owner_user_id
         from applications a
         where not exists (
           select 1 from users u where u.id = a.owner_user_id
         )
         limit 10`
      );
      await logCheckResult({
        event: "startup_orphaned_applications",
        count: orphanApplicationsCount.rows[0]?.count ?? 0,
        sample: orphanApplicationsSample.rows,
      });
    }

    const hasPipelineState = await hasColumn("applications", "pipeline_state");
    if (!hasApplications || !hasPipelineState) {
      logInfo("startup_invalid_pipeline_states_skipped", {
        reason: "missing_applications_or_pipeline_state",
      });
    } else {
      const invalidPipelineCount = await pool.runQuery<{ count: number }>(
        `select count(*)::int as count
         from applications
         where not (pipeline_state = any($1::text[]))`,
        [PIPELINE_STATES]
      );
      const invalidPipelineSample = await pool.runQuery<SampleRow>(
        `select id, pipeline_state
         from applications
         where not (pipeline_state = any($1::text[]))
         limit 10`,
        [PIPELINE_STATES]
      );
      await logCheckResult({
        event: "startup_invalid_pipeline_states",
        count: invalidPipelineCount.rows[0]?.count ?? 0,
        sample: invalidPipelineSample.rows,
      });
    }
  } catch (err) {
    logError("startup_consistency_check_failed", {
      error: err instanceof Error ? err.message : "unknown_error",
    });
  }
}
