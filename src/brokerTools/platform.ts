// BF_SERVER_v867_BROKER_TOOLS - the few things that differ between Boreal's server and Keystone: Boreal has no plans (every tool
// is on), no team record visibility (the silo check in each route is the guard), no usage billing, and its own brand.
// Everything else in src/brokerTools is identical in both.
import type { NextFunction, Request, RequestHandler, Response } from "express";

export const PLATFORM = "boreal" as const;

export type BrokerFeature =
  | "funding_conditions" | "sales_tax"
  | "invoice_reading" | "credit_lines" | "rate_cards" | "credit_scorecards" | "contract_templates" | "vendor_portal" | "credit_bureau";

export function passThrough(_req: Request, _res: Response, next: NextFunction): void {
  next();
}

/** Boreal has no plans: every broker tool is on. */
export function gate(_feature: BrokerFeature): RequestHandler {
  return passThrough;
}

/** Boreal has no plans: every broker tool is on (for work outside a request, e.g. the reminders worker). */
export async function featureOn(_feature: BrokerFeature): Promise<boolean> {
  return true;
}

/** Keystone bills some uses (e.g. a credit bureau pull) through its operations service; Boreal does not. */
export async function recordUsage(_kind: string, _ref: string): Promise<void> {
  return;
}

/** Keystone counts e-signatures against the plan's allowance; Boreal does not. */
export async function countSignings(_groupId: string, _signers: { email: string; role: string }[]): Promise<void> {
  return;
}

/** Boreal has no team record visibility: staff who pass the silo check may see the application. */
export async function canSeeApplication(_req: Request, _applicationId: string): Promise<boolean> {
  return true;
}

export function brand(): string {
  return "Boreal Financial";
}

export function clientAppUrl(): string {
  return String(process.env.CLIENT_URL ?? "").trim().replace(/\/+$/, "") || "https://client.boreal.financial";
}

export function staffPortalUrl(): string {
  return String(process.env.PORTAL_URL ?? "").trim().replace(/\/+$/, "") || "https://staff.boreal.financial";
}
