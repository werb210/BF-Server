import { API_ROUTE_MOUNTS } from "../routes/routeRegistry";
import { config } from "../config";

export const API_V1_FROZEN = true;

const FROZEN_V1_MOUNTS = [
  "/_int",
  "/internal/processing",
  "/auth",
  "/applications",
  "/calendar",
  "/calls",
  "/client",
  "/communications",
  "/banking",
  "/crm",
  "/credit",
  "/dashboard",
  "/credit-summary",
  "/documents",
  "/lender",
  "/lender-submissions",
  "/lender-products",
  "/lenders",
  "/admin",
  "/marketing",
  "/offers",
  "/messages",
  "/reporting",
  "/reports",
  "/settings",
  "/staff",
  "/tasks",
  "/users",
  "/portal",
  "/pwa",
  "/referrals",
  "/pipeline",
  "/telephony",
  "/webhooks",
  "/website",
] as const;

export function assertApiV1Frozen(): void {
  if (!API_V1_FROZEN || config.flags.allowUnfrozenApiV1) {
    return;
  }
  const allowed = new Set<string>(FROZEN_V1_MOUNTS as readonly string[]);
  const violations = API_ROUTE_MOUNTS
    .map((entry) => entry.path)
    .filter((path) => !allowed.has(path) && !path.startsWith("/v2"));
  if (violations.length > 0) {
    throw new Error(
      `API_V1_FROZEN violation: add new routes under /api/v2. Violations: ${violations.join(", ")}`
    );
  }
}
