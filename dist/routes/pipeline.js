"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const db_1 = require("../db");
const auth_1 = require("../middleware/auth");
const capabilities_1 = require("../auth/capabilities");
const safeHandler_1 = require("../middleware/safeHandler");
const applications_service_1 = require("../modules/applications/applications.service");
const pipelineState_1 = require("../modules/applications/pipelineState");
const router = (0, express_1.Router)();
router.get("/", auth_1.requireAuth, (0, auth_1.requireCapability)([capabilities_1.CAPABILITIES.APPLICATION_READ]), (0, safeHandler_1.safeHandler)(async (_req, res) => {
    const result = await db_1.pool.runQuery(`select id, name, pipeline_state, updated_at
       from applications
       order by updated_at desc`);
    res.status(200).json({
        items: result.rows.map((row) => ({
            id: row.id,
            name: row.name,
            stage: row.pipeline_state ?? pipelineState_1.ApplicationStage.RECEIVED,
            updatedAt: row.updated_at,
        })),
    });
}));
router.get("/stages", auth_1.requireAuth, (0, auth_1.requireCapability)([capabilities_1.CAPABILITIES.APPLICATION_READ]), (0, safeHandler_1.safeHandler)(async (_req, res) => {
    res.status(200).json({ stages: (0, applications_service_1.fetchPipelineStates)() });
}));
exports.default = router;
