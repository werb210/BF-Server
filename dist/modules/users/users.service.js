"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.setUserStatus = setUserStatus;
exports.changeUserRole = changeUserRole;
const errors_1 = require("../../middleware/errors");
const audit_service_1 = require("../audit/audit.service");
const auth_repo_1 = require("../auth/auth.repo");
const db_1 = require("../../db");
async function setUserStatus(params) {
    const user = await (0, auth_repo_1.findAuthUserById)(params.userId);
    if (!user) {
        await (0, audit_service_1.recordAuditEvent)({
            action: params.active ? "user_enabled" : "user_disabled",
            actorUserId: params.actorId,
            targetUserId: params.userId,
            ip: params.ip ?? null,
            userAgent: params.userAgent ?? null,
            success: false,
        });
        throw new errors_1.AppError("not_found", "User not found.", 404);
    }
    const client = await db_1.pool.connect();
    try {
        await client.query("begin");
        await (0, auth_repo_1.setUserActive)(params.userId, params.active, client);
        if (!params.active) {
            await (0, auth_repo_1.incrementTokenVersion)(params.userId, client);
            await (0, auth_repo_1.revokeRefreshTokensForUser)(params.userId, client);
            await (0, audit_service_1.recordAuditEvent)({
                action: "token_revoke",
                actorUserId: params.actorId,
                targetUserId: params.userId,
                ip: params.ip ?? null,
                userAgent: params.userAgent ?? null,
                success: true,
                client,
            });
        }
        await (0, audit_service_1.recordAuditEvent)({
            action: params.active ? "user_enabled" : "user_disabled",
            actorUserId: params.actorId,
            targetUserId: params.userId,
            ip: params.ip ?? null,
            userAgent: params.userAgent ?? null,
            success: true,
            client,
        });
        await client.query("commit");
    }
    catch (err) {
        await client.query("rollback");
        await (0, audit_service_1.recordAuditEvent)({
            action: params.active ? "user_enabled" : "user_disabled",
            actorUserId: params.actorId,
            targetUserId: params.userId,
            ip: params.ip ?? null,
            userAgent: params.userAgent ?? null,
            success: false,
        });
        throw err;
    }
    finally {
        client.release();
    }
}
async function changeUserRole(params) {
    const user = await (0, auth_repo_1.findAuthUserById)(params.userId);
    if (!user) {
        await (0, audit_service_1.recordAuditEvent)({
            action: "user_role_changed",
            actorUserId: params.actorId,
            targetUserId: params.userId,
            ip: params.ip ?? null,
            userAgent: params.userAgent ?? null,
            success: false,
        });
        throw new errors_1.AppError("not_found", "User not found.", 404);
    }
    const client = await db_1.pool.connect();
    try {
        await client.query("begin");
        await (0, auth_repo_1.updateUserRoleById)(params.userId, params.role, client);
        await (0, auth_repo_1.incrementTokenVersion)(params.userId, client);
        await (0, auth_repo_1.revokeRefreshTokensForUser)(params.userId, client);
        await (0, audit_service_1.recordAuditEvent)({
            action: "token_revoke",
            actorUserId: params.actorId,
            targetUserId: params.userId,
            ip: params.ip ?? null,
            userAgent: params.userAgent ?? null,
            success: true,
            client,
        });
        await (0, audit_service_1.recordAuditEvent)({
            action: "user_role_changed",
            actorUserId: params.actorId,
            targetUserId: params.userId,
            ip: params.ip ?? null,
            userAgent: params.userAgent ?? null,
            success: true,
            client,
        });
        await client.query("commit");
    }
    catch (err) {
        await client.query("rollback");
        await (0, audit_service_1.recordAuditEvent)({
            action: "user_role_changed",
            actorUserId: params.actorId,
            targetUserId: params.userId,
            ip: params.ip ?? null,
            userAgent: params.userAgent ?? null,
            success: false,
        });
        throw err;
    }
    finally {
        client.release();
    }
}
