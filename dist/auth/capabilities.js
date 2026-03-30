"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.CAPABILITIES = void 0;
exports.fetchCapabilitiesForRole = fetchCapabilitiesForRole;
exports.isCapability = isCapability;
exports.fetchRolesForCapabilities = fetchRolesForCapabilities;
const roles_1 = require("./roles");
exports.CAPABILITIES = {
    STAFF_OVERVIEW: "staff:overview",
    USER_MANAGE: "user:manage",
    APPLICATION_READ: "application:read",
    APPLICATION_CREATE: "application:create",
    DOCUMENT_UPLOAD: "document:upload",
    DOCUMENT_REVIEW: "document:review",
    PIPELINE_MANAGE: "pipeline:manage",
    PIPELINE_OVERRIDE: "pipeline:override",
    LENDER_SUBMIT: "lender:submit",
    LENDERS_READ: "lenders:read",
    CRM_READ: "crm:read",
    COMMUNICATIONS_READ: "communications:read",
    COMMUNICATIONS_CALL: "communications:call",
    CALENDAR_READ: "calendar:read",
    MARKETING_READ: "marketing:read",
    SETTINGS_READ: "settings:read",
    AUDIT_VIEW: "audit:view",
    ACCOUNT_UNLOCK: "account:unlock",
    REPORT_VIEW: "report:view",
    OPS_MANAGE: "ops:manage",
    LENDER_PRODUCTS_READ: "lender_products:read",
    LENDER_PRODUCTS_WRITE: "lender_products:write",
};
const CAPABILITY_SET = new Set(Object.values(exports.CAPABILITIES));
/**
 * IMPORTANT INVARIANTS
 * - Every Role MUST be present
 * - Returned arrays MUST be immutable copies
 * - OPS_MANAGE is an absolute override handled at middleware level
 */
const ROLE_CAPABILITIES = {
    [roles_1.ROLES.ADMIN]: [
        exports.CAPABILITIES.STAFF_OVERVIEW,
        exports.CAPABILITIES.USER_MANAGE,
        exports.CAPABILITIES.APPLICATION_READ,
        exports.CAPABILITIES.APPLICATION_CREATE,
        exports.CAPABILITIES.DOCUMENT_UPLOAD,
        exports.CAPABILITIES.DOCUMENT_REVIEW,
        exports.CAPABILITIES.PIPELINE_MANAGE,
        exports.CAPABILITIES.PIPELINE_OVERRIDE,
        exports.CAPABILITIES.LENDER_SUBMIT,
        exports.CAPABILITIES.LENDERS_READ,
        exports.CAPABILITIES.CRM_READ,
        exports.CAPABILITIES.COMMUNICATIONS_READ,
        exports.CAPABILITIES.COMMUNICATIONS_CALL,
        exports.CAPABILITIES.CALENDAR_READ,
        exports.CAPABILITIES.MARKETING_READ,
        exports.CAPABILITIES.SETTINGS_READ,
        exports.CAPABILITIES.AUDIT_VIEW,
        exports.CAPABILITIES.ACCOUNT_UNLOCK,
        exports.CAPABILITIES.REPORT_VIEW,
        exports.CAPABILITIES.OPS_MANAGE,
        exports.CAPABILITIES.LENDER_PRODUCTS_READ,
        exports.CAPABILITIES.LENDER_PRODUCTS_WRITE,
    ],
    [roles_1.ROLES.OPS]: [
        exports.CAPABILITIES.STAFF_OVERVIEW,
        exports.CAPABILITIES.USER_MANAGE,
        exports.CAPABILITIES.APPLICATION_READ,
        exports.CAPABILITIES.APPLICATION_CREATE,
        exports.CAPABILITIES.DOCUMENT_UPLOAD,
        exports.CAPABILITIES.DOCUMENT_REVIEW,
        exports.CAPABILITIES.PIPELINE_MANAGE,
        exports.CAPABILITIES.PIPELINE_OVERRIDE,
        exports.CAPABILITIES.LENDER_SUBMIT,
        exports.CAPABILITIES.LENDERS_READ,
        exports.CAPABILITIES.CRM_READ,
        exports.CAPABILITIES.COMMUNICATIONS_READ,
        exports.CAPABILITIES.COMMUNICATIONS_CALL,
        exports.CAPABILITIES.CALENDAR_READ,
        exports.CAPABILITIES.MARKETING_READ,
        exports.CAPABILITIES.SETTINGS_READ,
        exports.CAPABILITIES.AUDIT_VIEW,
        exports.CAPABILITIES.ACCOUNT_UNLOCK,
        exports.CAPABILITIES.REPORT_VIEW,
        exports.CAPABILITIES.OPS_MANAGE,
        exports.CAPABILITIES.LENDER_PRODUCTS_READ,
        exports.CAPABILITIES.LENDER_PRODUCTS_WRITE,
    ],
    [roles_1.ROLES.STAFF]: [
        exports.CAPABILITIES.STAFF_OVERVIEW,
        exports.CAPABILITIES.APPLICATION_READ,
        exports.CAPABILITIES.APPLICATION_CREATE,
        exports.CAPABILITIES.DOCUMENT_UPLOAD,
        exports.CAPABILITIES.DOCUMENT_REVIEW,
        exports.CAPABILITIES.PIPELINE_MANAGE,
        exports.CAPABILITIES.PIPELINE_OVERRIDE,
        exports.CAPABILITIES.LENDER_SUBMIT,
        exports.CAPABILITIES.CRM_READ,
        exports.CAPABILITIES.COMMUNICATIONS_READ,
        exports.CAPABILITIES.COMMUNICATIONS_CALL,
        exports.CAPABILITIES.CALENDAR_READ,
        exports.CAPABILITIES.MARKETING_READ,
        exports.CAPABILITIES.SETTINGS_READ,
        exports.CAPABILITIES.LENDER_PRODUCTS_READ,
        exports.CAPABILITIES.LENDER_PRODUCTS_WRITE,
    ],
    [roles_1.ROLES.LENDER]: [
        exports.CAPABILITIES.LENDER_SUBMIT,
        exports.CAPABILITIES.LENDERS_READ,
        exports.CAPABILITIES.LENDER_PRODUCTS_READ,
        exports.CAPABILITIES.LENDER_PRODUCTS_WRITE,
    ],
    [roles_1.ROLES.REFERRER]: [
        exports.CAPABILITIES.APPLICATION_CREATE,
        exports.CAPABILITIES.DOCUMENT_UPLOAD,
    ],
};
/**
 * Returns a defensive copy.
 * Never return the internal array.
 */
function fetchCapabilitiesForRole(role) {
    const caps = ROLE_CAPABILITIES[role];
    if (!caps) {
        // Compile-time safety should prevent this, but runtime must still guard
        throw new Error(`No capabilities defined for role: ${role}`);
    }
    return [...caps];
}
function isCapability(value) {
    return typeof value === "string" && CAPABILITY_SET.has(value);
}
function fetchRolesForCapabilities(required) {
    const requiredList = [...required];
    return Object.entries(ROLE_CAPABILITIES)
        .filter(([_, caps]) => requiredList.every((cap) => caps.includes(cap)))
        .map(([role]) => role);
}
