"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.handleListCrmTimeline = handleListCrmTimeline;
const respondOk_1 = require("../../utils/respondOk");
const timeline_repo_1 = require("./timeline.repo");
async function handleListCrmTimeline(req, res) {
    const page = Number(req.query.page) || 1;
    const pageSize = Number(req.query.pageSize) || 25;
    const entityType = typeof req.query.entityType === "string" ? req.query.entityType : null;
    const entityId = typeof req.query.entityId === "string" ? req.query.entityId : null;
    const ruleId = typeof req.query.ruleId === "string" ? req.query.ruleId : null;
    const limit = Math.min(200, Math.max(1, pageSize));
    const offset = Math.max(0, (page - 1) * limit);
    const entries = await (0, timeline_repo_1.listCrmTimeline)({
        entityType,
        entityId,
        ruleId,
        limit,
        offset,
    });
    (0, respondOk_1.respondOk)(res, {
        entries,
        total: entries.length,
    }, {
        page,
        pageSize: limit,
    });
}
