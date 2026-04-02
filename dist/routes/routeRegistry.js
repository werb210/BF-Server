"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.ROUTES = exports.V1_REQUIRED_ROUTE_SURFACE = exports.PORTAL_ROUTE_REQUIREMENTS = exports.API_ROUTE_MOUNTS = void 0;
exports.registerApiRouteMounts = registerApiRouteMounts;
const express_1 = require("express");
const roles_1 = require("../auth/roles");
const admin_1 = __importDefault(require("./admin"));
const applications_routes_1 = __importDefault(require("../modules/applications/applications.routes"));
const banking_1 = __importDefault(require("./banking"));
const calendar_1 = __importDefault(require("./calendar"));
const calls_1 = __importDefault(require("./calls"));
const client_1 = __importDefault(require("./client"));
const communications_1 = __importDefault(require("./communications"));
const crm_1 = __importDefault(require("./crm"));
const credit_1 = __importDefault(require("./credit"));
const creditSummary_1 = __importDefault(require("./creditSummary"));
const dashboard_1 = __importDefault(require("./dashboard"));
const documents_1 = __importDefault(require("./documents"));
const _int_1 = __importDefault(require("./_int"));
const processing_1 = __importDefault(require("./internal/processing"));
const lenderSubmissions_1 = __importDefault(require("./lenderSubmissions"));
const marketing_1 = __importDefault(require("./marketing"));
const offers_1 = __importDefault(require("./offers"));
const messages_1 = __importDefault(require("./messages"));
const reporting_1 = __importDefault(require("./reporting"));
const reports_1 = __importDefault(require("./reports"));
const settings_1 = __importDefault(require("./settings"));
const staff_1 = __importDefault(require("./staff"));
const tasks_1 = __importDefault(require("./tasks"));
const users_1 = __importDefault(require("./users"));
const portal_1 = __importDefault(require("./portal"));
const pwa_1 = __importDefault(require("./pwa"));
const referrals_1 = __importDefault(require("./referrals"));
const pipeline_1 = __importDefault(require("./pipeline"));
const telephonyRoutes_1 = __importDefault(require("../telephony/routes/telephonyRoutes"));
const webhooks_1 = __importDefault(require("./webhooks"));
const website_1 = __importDefault(require("./website"));
const _canonicalMount_1 = require("./_canonicalMount");
const ALL_ROLES = [
    roles_1.ROLES.ADMIN,
    roles_1.ROLES.STAFF,
    roles_1.ROLES.LENDER,
    roles_1.ROLES.REFERRER,
];
exports.API_ROUTE_MOUNTS = [
    { path: "/_int", router: _int_1.default },
    { path: "/internal/processing", router: processing_1.default },
    { path: "/calendar", router: calendar_1.default },
    { path: "/calls", router: calls_1.default },
    { path: "/telephony", router: telephonyRoutes_1.default },
    { path: "/banking", router: banking_1.default },
    { path: "/client", router: client_1.default },
    { path: "/communications", router: communications_1.default },
    { path: "/credit", router: credit_1.default },
    { path: "/crm", router: crm_1.default },
    { path: "/dashboard", router: dashboard_1.default },
    { path: "/credit-summary", router: creditSummary_1.default },
    { path: "/documents", router: documents_1.default },
    { path: "/lender-submissions", router: lenderSubmissions_1.default },
    { path: "/admin", router: admin_1.default },
    { path: "/marketing", router: marketing_1.default },
    { path: "/offers", router: offers_1.default },
    { path: "/messages", router: messages_1.default },
    { path: "/reporting", router: reporting_1.default },
    { path: "/reports", router: reports_1.default },
    { path: "/settings", router: settings_1.default },
    { path: "/staff", router: staff_1.default },
    { path: "/tasks", router: tasks_1.default },
    { path: "/users", router: users_1.default },
    { path: "/portal", router: portal_1.default },
    { path: "/pwa", router: pwa_1.default },
    { path: "/referrals", router: referrals_1.default },
    { path: "/pipeline", router: pipeline_1.default },
    { path: "/webhooks", router: webhooks_1.default },
    { path: "/website", router: website_1.default },
    { path: "/applications", router: applications_routes_1.default },
];
exports.PORTAL_ROUTE_REQUIREMENTS = [
    { method: "GET", path: "/api/auth/me" },
    { method: "GET", path: "/api/dashboard" },
    { method: "GET", path: "/api/client/submissions" },
    { method: "GET", path: "/api/crm" },
    { method: "GET", path: "/api/calendar" },
    { method: "GET", path: "/api/communications" },
    { method: "GET", path: "/api/marketing" },
    { method: "GET", path: "/api/lenders" },
    { method: "GET", path: "/api/settings" },
];
exports.V1_REQUIRED_ROUTE_SURFACE = [
    "/api/client",
    "/api/portal",
    "/api/documents",
    "/api/banking",
    "/api/credit",
    "/api/lenders",
    "/api/offers",
    "/api/messages",
    "/api/calls",
    "/api/health",
];
exports.ROUTES = [
    { method: "POST", path: "/auth/otp/start", roles: ALL_ROLES },
    { method: "POST", path: "/auth/otp/verify", roles: ALL_ROLES },
    { method: "GET", path: "/api/auth/me", roles: ALL_ROLES },
    { method: "POST", path: "/api/auth/logout", roles: ALL_ROLES },
    { method: "GET", path: "/telephony/token", roles: [roles_1.ROLES.ADMIN, roles_1.ROLES.STAFF] },
    { method: "POST", path: "/api/telephony/outbound-call", roles: [roles_1.ROLES.ADMIN, roles_1.ROLES.STAFF] },
    { method: "POST", path: "/api/telephony/presence", roles: [roles_1.ROLES.ADMIN, roles_1.ROLES.STAFF] },
    { method: "POST", path: "/api/telephony/call-status", roles: [roles_1.ROLES.ADMIN, roles_1.ROLES.STAFF] },
    { method: "POST", path: "/api/webhooks/twilio/voice", roles: [] },
    { method: "GET", path: "/api/dialer/token", roles: [roles_1.ROLES.ADMIN, roles_1.ROLES.STAFF] },
    { method: "POST", path: "/api/twilio/voice", roles: [] },
    { method: "POST", path: "/api/twilio/voice/action", roles: [] },
    { method: "POST", path: "/api/twilio/recording", roles: [] },
    { method: "POST", path: "/api/twilio/status", roles: [] },
    { method: "POST", path: "/api/calls/start", roles: [roles_1.ROLES.ADMIN, roles_1.ROLES.STAFF] },
    { method: "POST", path: "/api/calls/:id/status", roles: [roles_1.ROLES.ADMIN, roles_1.ROLES.STAFF] },
    { method: "POST", path: "/api/calls/:id/end", roles: [roles_1.ROLES.ADMIN, roles_1.ROLES.STAFF] },
    { method: "GET", path: "/api/calls", roles: [roles_1.ROLES.ADMIN, roles_1.ROLES.STAFF] },
    { method: "GET", path: "/api/client/submissions", roles: [roles_1.ROLES.ADMIN, roles_1.ROLES.STAFF] },
    { method: "GET", path: "/api/client/submissions/:id/ocr-insights", roles: [roles_1.ROLES.ADMIN, roles_1.ROLES.STAFF] },
    { method: "POST", path: "/api/client/submissions/:id/open", roles: [roles_1.ROLES.ADMIN, roles_1.ROLES.STAFF] },
    { method: "GET", path: "/api/pipeline", roles: [roles_1.ROLES.ADMIN, roles_1.ROLES.STAFF] },
    { method: "GET", path: "/api/pipeline/stages", roles: [roles_1.ROLES.ADMIN, roles_1.ROLES.STAFF] },
    { method: "GET", path: "/api/crm", roles: [roles_1.ROLES.ADMIN, roles_1.ROLES.STAFF] },
    { method: "GET", path: "/api/crm/contacts", roles: [roles_1.ROLES.ADMIN, roles_1.ROLES.STAFF] },
    { method: "GET", path: "/api/communications", roles: [roles_1.ROLES.ADMIN, roles_1.ROLES.STAFF] },
    { method: "GET", path: "/api/calendar", roles: [roles_1.ROLES.ADMIN, roles_1.ROLES.STAFF] },
    { method: "GET", path: "/api/calendar/events", roles: [roles_1.ROLES.ADMIN, roles_1.ROLES.STAFF] },
    { method: "GET", path: "/api/tasks", roles: [roles_1.ROLES.ADMIN, roles_1.ROLES.STAFF] },
    { method: "GET", path: "/api/marketing", roles: [roles_1.ROLES.ADMIN, roles_1.ROLES.STAFF] },
    { method: "GET", path: "/api/lenders", roles: [roles_1.ROLES.ADMIN, roles_1.ROLES.STAFF] },
    { method: "GET", path: "/api/settings", roles: [roles_1.ROLES.ADMIN, roles_1.ROLES.STAFF] },
    { method: "GET", path: "/api/staff/overview", roles: [roles_1.ROLES.ADMIN, roles_1.ROLES.STAFF] },
    { method: "GET", path: "/api/dashboard", roles: [roles_1.ROLES.ADMIN, roles_1.ROLES.STAFF] },
    { method: "POST", path: "/api/referrals", roles: [roles_1.ROLES.ADMIN, roles_1.ROLES.STAFF, roles_1.ROLES.REFERRER] },
    { method: "POST", path: "/api/website/credit-readiness", roles: [] },
    { method: "POST", path: "/api/website/contact", roles: [] },
    { method: "POST", path: "/api/public/application/start", roles: [] },
    { method: "POST", path: "/api/public/readiness", roles: [] },
    { method: "GET", path: "/api/client/continuation/:token", roles: [] },
    { method: "GET", path: "/api/portal/readiness-leads", roles: [roles_1.ROLES.ADMIN] },
    { method: "POST", path: "/api/portal/readiness-leads/:id/convert", roles: [roles_1.ROLES.ADMIN] },
    { method: "GET", path: "/api/portal/applications/:id/readiness", roles: [roles_1.ROLES.ADMIN] },
];
function registerApiRouteMounts(app) {
    const apiRouter = (0, express_1.Router)();
    exports.API_ROUTE_MOUNTS.forEach((entry) => {
        (0, _canonicalMount_1.mount)(apiRouter, entry.path, entry.router);
    });
    app.use("/api/v1", apiRouter);
}
