"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.runStartupConsistencyCheck = runStartupConsistencyCheck;
const config_1 = require("../config");
const db_1 = require("../db");
const logger_1 = require("../observability/logger");
const pipelineState_1 = require("../modules/applications/pipelineState");
async function logCheckResult(params) {
    if (params.count > 0) {
        (0, logger_1.logWarn)(params.event, { count: params.count, sample: params.sample });
        return;
    }
    (0, logger_1.logInfo)(params.event, { count: params.count });
}
async function hasTable(table) {
    const res = await (0, db_1.runQuery)(`select count(*)::int as count
     from information_schema.tables
     where table_name = $1`, [table]);
    return (res.rows[0]?.count ?? 0) > 0;
}
async function hasColumn(table, column) {
    const res = await (0, db_1.runQuery)(`select count(*)::int as count
     from information_schema.columns
     where table_name = $1
       and column_name = $2`, [table, column]);
    return (res.rows[0]?.count ?? 0) > 0;
}
async function runStartupConsistencyCheck() {
    if (config_1.config.env === "test") {
        return;
    }
    try {
        const hasDocuments = await hasTable("documents");
        const hasApplications = await hasTable("applications");
        const hasDocumentApplicationId = await hasColumn("documents", "application_id");
        if (!hasDocuments || !hasApplications || !hasDocumentApplicationId) {
            (0, logger_1.logInfo)("startup_orphaned_documents_skipped", {
                reason: "missing_documents_or_applications",
            });
        }
        else {
            const orphanDocumentsCount = await (0, db_1.runQuery)(`select count(*)::int as count
         from documents d
         where not exists (
           select 1 from applications a where a.id = d.application_id
         )`);
            const orphanDocumentsSample = await (0, db_1.runQuery)(`select d.id, d.application_id
         from documents d
         where not exists (
           select 1 from applications a where a.id = d.application_id
         )
         limit 10`);
            await logCheckResult({
                event: "startup_orphaned_documents",
                count: orphanDocumentsCount.rows[0]?.count ?? 0,
                sample: orphanDocumentsSample.rows,
            });
        }
        const hasUsers = await hasTable("users");
        const hasOwnerUserId = await hasColumn("applications", "owner_user_id");
        if (!hasApplications || !hasUsers || !hasOwnerUserId) {
            (0, logger_1.logInfo)("startup_orphaned_applications_skipped", {
                reason: "missing_applications_users_or_owner",
            });
        }
        else {
            const orphanApplicationsCount = await (0, db_1.runQuery)(`select count(*)::int as count
         from applications a
         where not exists (
           select 1 from users u where u.id = a.owner_user_id
         )`);
            const orphanApplicationsSample = await (0, db_1.runQuery)(`select a.id, a.owner_user_id
         from applications a
         where not exists (
           select 1 from users u where u.id = a.owner_user_id
         )
         limit 10`);
            await logCheckResult({
                event: "startup_orphaned_applications",
                count: orphanApplicationsCount.rows[0]?.count ?? 0,
                sample: orphanApplicationsSample.rows,
            });
        }
        const hasPipelineState = await hasColumn("applications", "pipeline_state");
        if (!hasApplications || !hasPipelineState) {
            (0, logger_1.logInfo)("startup_invalid_pipeline_states_skipped", {
                reason: "missing_applications_or_pipeline_state",
            });
        }
        else {
            const invalidPipelineCount = await (0, db_1.runQuery)(`select count(*)::int as count
         from applications
         where not (pipeline_state = any($1::text[]))`, [pipelineState_1.PIPELINE_STATES]);
            const invalidPipelineSample = await (0, db_1.runQuery)(`select id, pipeline_state
         from applications
         where not (pipeline_state = any($1::text[]))
         limit 10`, [pipelineState_1.PIPELINE_STATES]);
            await logCheckResult({
                event: "startup_invalid_pipeline_states",
                count: invalidPipelineCount.rows[0]?.count ?? 0,
                sample: invalidPipelineSample.rows,
            });
        }
    }
    catch (err) {
        (0, logger_1.logError)("startup_consistency_check_failed", {
            error: err instanceof Error ? err.message : "unknown_error",
        });
    }
}
