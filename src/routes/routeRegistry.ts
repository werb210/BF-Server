import { Router } from "express";
import { ROLES, type Role } from "../auth/roles";
import adminRoutes from "./admin";
import applicationsRoutes from "../modules/applications/applications.routes";
import bankingRoutes from "./banking";
import calendarRoutes from "./calendar";
import callsRoutes from "./calls";
import clientRoutes from "./client";
import communicationsRoutes from "./communications";
import crmRoutes from "./crm";
import creditRoutes from "./credit";
import creditSummaryRoutes from "./creditSummary";
import dashboardRoutes from "./dashboard";
import documentsRoutes from "./documents";
import internalRoutes from "./_int";
import internalProcessingRoutes from "./internal/processing";
import lenderSubmissionsRoutes from "./lenderSubmissions";
import lenderProductsRoutes from "./lenderProducts";
import lendersRoutes from "./lenders";
import marketingRoutes from "./marketing";
import offersRoutes from "./offers";
import messagesRoutes from "./messages";
import reportingRoutes from "./reporting";
import reportsRoutes from "./reports";
import settingsRoutes from "./settings";
import staffRoutes from "./staff";
import tasksRoutes from "./tasks";
import usersRoutes from "./users";
import portalRoutes from "./portal";
import pwaRoutes from "./pwa";
import referralsRoutes from "./referrals";
import pipelineRoutes from "./pipeline";
import telephonyRoutes from "../telephony/routes/telephonyRoutes";
import webhooksRoutes from "./webhooks";
import websiteRoutes from "./website";
import { mount } from "./_canonicalMount";

export type ApiRoute = {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
  roles: Role[];
};

export type ApiRouteMount = {
  path: string;
  router: Router;
};

const ALL_ROLES: Role[] = [
  ROLES.ADMIN,
  ROLES.STAFF,
  ROLES.LENDER,
  ROLES.REFERRER,
];

export const API_ROUTE_MOUNTS: ApiRouteMount[] = [
  { path: "/_int", router: internalRoutes },
  { path: "/internal/processing", router: internalProcessingRoutes },
  { path: "/calendar", router: calendarRoutes },
  { path: "/calls", router: callsRoutes },
  { path: "/telephony", router: telephonyRoutes },
  { path: "/banking", router: bankingRoutes },
  { path: "/client", router: clientRoutes },
  { path: "/communications", router: communicationsRoutes },
  { path: "/credit", router: creditRoutes },
  { path: "/crm", router: crmRoutes },
  { path: "/dashboard", router: dashboardRoutes },
  { path: "/credit-summary", router: creditSummaryRoutes },
  { path: "/documents", router: documentsRoutes },
  { path: "/lender-submissions", router: lenderSubmissionsRoutes },
  { path: "/lender-products", router: lenderProductsRoutes },
  { path: "/lenders", router: lendersRoutes },
  { path: "/admin", router: adminRoutes },
  { path: "/marketing", router: marketingRoutes },
  { path: "/offers", router: offersRoutes },
  { path: "/messages", router: messagesRoutes },
  { path: "/reporting", router: reportingRoutes },
  { path: "/reports", router: reportsRoutes },
  { path: "/settings", router: settingsRoutes },
  { path: "/staff", router: staffRoutes },
  { path: "/tasks", router: tasksRoutes },
  { path: "/users", router: usersRoutes },
  { path: "/portal", router: portalRoutes },
  { path: "/pwa", router: pwaRoutes },
  { path: "/referrals", router: referralsRoutes },
  { path: "/pipeline", router: pipelineRoutes },
  { path: "/webhooks", router: webhooksRoutes },
  { path: "/website", router: websiteRoutes },
  { path: "/applications", router: applicationsRoutes },
];

export const PORTAL_ROUTE_REQUIREMENTS: Pick<ApiRoute, "method" | "path">[] = [
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


export const V1_REQUIRED_ROUTE_SURFACE = [
  "/api/client",
  "/api/portal",
  "/api/documents",
  "/api/banking",
  "/api/credit",
  "/api/lenders",
  "/api/offers",
  "/api/messages",
  "/api/calls",
] as const;

export const ROUTES: ApiRoute[] = [
  { method: "POST", path: "/api/auth/otp/start", roles: ALL_ROLES },
  { method: "POST", path: "/api/auth/otp/verify", roles: ALL_ROLES },
  { method: "GET", path: "/api/auth/me", roles: ALL_ROLES },
  { method: "POST", path: "/api/auth/logout", roles: ALL_ROLES },
  { method: "POST", path: "/api/telephony/token", roles: [ROLES.ADMIN, ROLES.STAFF] },
  { method: "POST", path: "/api/telephony/outbound-call", roles: [ROLES.ADMIN, ROLES.STAFF] },
  { method: "POST", path: "/api/telephony/presence", roles: [ROLES.ADMIN, ROLES.STAFF] },
  { method: "POST", path: "/api/telephony/call-status", roles: [ROLES.ADMIN, ROLES.STAFF] },
  { method: "POST", path: "/api/webhooks/twilio/voice", roles: [] },
  { method: "GET", path: "/api/dialer/token", roles: [ROLES.ADMIN, ROLES.STAFF] },
  { method: "POST", path: "/api/twilio/voice", roles: [] },
  { method: "POST", path: "/api/twilio/voice/action", roles: [] },
  { method: "POST", path: "/api/twilio/recording", roles: [] },
  { method: "POST", path: "/api/twilio/status", roles: [] },
  { method: "POST", path: "/api/calls/start", roles: [ROLES.ADMIN, ROLES.STAFF] },
  { method: "POST", path: "/api/calls/:id/status", roles: [ROLES.ADMIN, ROLES.STAFF] },
  { method: "POST", path: "/api/calls/:id/end", roles: [ROLES.ADMIN, ROLES.STAFF] },
  { method: "GET", path: "/api/calls", roles: [ROLES.ADMIN, ROLES.STAFF] },
  { method: "GET", path: "/api/client/submissions", roles: [ROLES.ADMIN, ROLES.STAFF] },
  { method: "GET", path: "/api/client/submissions/:id/ocr-insights", roles: [ROLES.ADMIN, ROLES.STAFF] },
  { method: "POST", path: "/api/client/submissions/:id/open", roles: [ROLES.ADMIN, ROLES.STAFF] },
  { method: "GET", path: "/api/pipeline", roles: [ROLES.ADMIN, ROLES.STAFF] },
  { method: "GET", path: "/api/pipeline/stages", roles: [ROLES.ADMIN, ROLES.STAFF] },
  { method: "GET", path: "/api/crm", roles: [ROLES.ADMIN, ROLES.STAFF] },
  { method: "GET", path: "/api/crm/contacts", roles: [ROLES.ADMIN, ROLES.STAFF] },
  { method: "GET", path: "/api/communications", roles: [ROLES.ADMIN, ROLES.STAFF] },
  { method: "GET", path: "/api/calendar", roles: [ROLES.ADMIN, ROLES.STAFF] },
  { method: "GET", path: "/api/calendar/events", roles: [ROLES.ADMIN, ROLES.STAFF] },
  { method: "GET", path: "/api/tasks", roles: [ROLES.ADMIN, ROLES.STAFF] },
  { method: "GET", path: "/api/marketing", roles: [ROLES.ADMIN, ROLES.STAFF] },
  { method: "GET", path: "/api/lenders", roles: [ROLES.ADMIN, ROLES.STAFF] },
  { method: "GET", path: "/api/settings", roles: [ROLES.ADMIN, ROLES.STAFF] },
  { method: "GET", path: "/api/staff/overview", roles: [ROLES.ADMIN, ROLES.STAFF] },
  { method: "GET", path: "/api/dashboard", roles: [ROLES.ADMIN, ROLES.STAFF] },
  { method: "POST", path: "/api/referrals", roles: [ROLES.ADMIN, ROLES.STAFF, ROLES.REFERRER] },
  { method: "POST", path: "/api/website/credit-readiness", roles: [] },
  { method: "POST", path: "/api/website/contact", roles: [] },
  { method: "POST", path: "/api/public/application/start", roles: [] },
  { method: "GET", path: "/api/client/continuation/:token", roles: [] },
  { method: "GET", path: "/api/portal/readiness-leads", roles: [ROLES.ADMIN] },
  { method: "POST", path: "/api/portal/readiness-leads/:id/convert", roles: [ROLES.ADMIN] },
  { method: "GET", path: "/api/portal/applications/:id/readiness", roles: [ROLES.ADMIN] },
];

export function registerApiRouteMounts(app: Router): void {
  const apiRouter = Router();

  API_ROUTE_MOUNTS.forEach((entry) => {
    mount(apiRouter, entry.path, entry.router);
  });

  app.use("/api", apiRouter);
}
