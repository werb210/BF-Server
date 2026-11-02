// BF_SERVER_v870_CRM_DATA_MODEL - one guard for every route that addresses a single contact, company or application by id.
//
// Mounted at the top of a router with the router-relative paths that carry a record id. When the path matches and the
// user may not see that record the request ends with 404 (the same answer as a record that does not exist, so ids
// cannot be probed). Sub-resources (notes, emails, calls, timeline, documents, offers...) live under the same paths
// and are covered with them. A document or note id resolves to its application / contact first.
import type { NextFunction, Request, RequestHandler, Response } from "express";
import { pool } from "../db.js";
import { requireAuthAllowClient } from "../middleware/auth.js";
import { isStaffRole } from "../auth/roles.js";
import type { Q } from "../settingsPack/common.js";
import { canSeeRecord, scopeForRequest, type RecordKind } from "./scope.js";

export type GuardRule = {
  /** Matched against req.path (relative to the router); group 1 is the id. */
  pattern: RegExp;
  kind: RecordKind | "document";
  /** Path segments in group 1 that are not ids (e.g. "stages", "rejection-reasons"). */
  except?: readonly string[];
};

async function visible(db: Q, req: Request, rule: GuardRule, id: string): Promise<boolean> {
  const scope = await scopeForRequest(req, db);
  if (scope.mode === "all") return true;
  if (rule.kind === "document") {
    const r = await db.query(`SELECT application_id::text AS application_id FROM documents WHERE id::text = $1`, [id]);
    const appId = r.rows[0]?.application_id;
    return appId ? canSeeRecord(db, scope, "application", String(appId)) : true; // unknown document: the route answers 404
  }
  return canSeeRecord(db, scope, rule.kind, id);
}

/**
 * Express middleware for a router. requireFirst: authenticate (staff or client token) before checking when the router
 * authenticates per route rather than with router.use(requireAuth) (the route's own auth still runs afterwards, so a
 * client token still meets the route's own staff check).
 */
export function recordGuard(rules: GuardRule[], opts: { requireFirst?: boolean; db?: Q } = {}): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    let match: { rule: GuardRule; id: string } | null = null;
    for (const rule of rules) {
      const m = rule.pattern.exec(req.path);
      if (!m) continue;
      const id = decodeURIComponent(m[1] ?? "");
      if (!id || rule.except?.includes(id)) continue;
      match = { rule, id };
      break;
    }
    if (!match) { next(); return; }
    const { rule, id } = match;
    const check = () => {
      void (async () => {
        const u = (req as any).user;
        if (!u) { next(); return; } // not signed in: the route's own auth answers
        // Only staff are limited by record visibility. Clients (their own application's Q&A and documents) and service
        // principals are checked by the route itself, exactly as before.
        if (u.isServicePrincipal || u.principal === "service" || !isStaffRole(u.role)) { next(); return; }
        if (!(await visible(opts.db ?? (pool as unknown as Q), req, rule, id))) {
          res.status(404).json({ error: "not_found", message: "Record not found" });
          return;
        }
        next();
      })().catch(next);
    };
    if ((req as any).user || !opts.requireFirst) { check(); return; }
    void requireAuthAllowClient(req, res, check);
  };
}

const ID = "([^/]+)";
/** /api/crm (router-relative). */
export const CRM_RULES: GuardRule[] = [
  { pattern: new RegExp(`^/contacts/${ID}(?:/|$)`), kind: "contact", except: ["import", "dedupe-preview", "dedupe-merge", "bulk-delete", "bulk-tag", "bulk-assign", "merge"] },
  { pattern: new RegExp(`^/companies/${ID}(?:/|$)`), kind: "company", except: ["import", "bulk-delete", "bulk-tag", "bulk-assign"] },
  { pattern: new RegExp(`^/unified/contacts/${ID}(?:/|$)`), kind: "contact" },
  { pattern: new RegExp(`^/unified/companies/${ID}(?:/|$)`), kind: "company" },
  { pattern: new RegExp(`^/unified/(?:duplicates|ai-summary)/contacts?/${ID}(?:/|$)`), kind: "contact" },
  { pattern: new RegExp(`^/unified/(?:duplicates|ai-summary)/compan(?:y|ies)/${ID}(?:/|$)`), kind: "company" },
];
/** /api/companies */
export const COMPANIES_RULES: GuardRule[] = [{ pattern: new RegExp(`^/${ID}(?:/|$)`), kind: "company" }];
/** /api/portal */
export const PORTAL_RULES: GuardRule[] = [
  { pattern: new RegExp(`^/applications/${ID}(?:/|$)`), kind: "application", except: ["stages", "purge-junk-drafts"] },
  { pattern: new RegExp(`^/documents/${ID}(?:/|$)`), kind: "document" },
];
/** /api/applications (the router also serves /:publicId/required-documents publicly - not matched here). */
export const APPLICATIONS_RULES: GuardRule[] = [
  { pattern: new RegExp(`^/${ID}(?:/(?!required-documents$)|$)`), kind: "application", except: ["rejection-reasons", "dup-debug", "phone-debug"] },
];
/** /api/documents: /:applicationId/documents/..., /:applicationId/duplicates and /:documentId/(category|accept|reject). */
export const DOCUMENTS_RULES: GuardRule[] = [
  { pattern: new RegExp(`^/${ID}/(?:documents|duplicates)(?:/|$)`), kind: "application" },
  { pattern: new RegExp(`^/${ID}/(?:category|accept|reject)$`), kind: "document" },
];

/**
 * For a router mounted under a path that carries the id (mergeParams), e.g. /api/applications/:id/notes: checks
 * req.params[param] after the route's own authentication has run.
 */
export function paramGuard(param: string, kind: RecordKind, db?: Q): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    void (async () => {
      const id = String((req.params as any)?.[param] ?? "");
      const u = (req as any).user;
      if (!id || !u || u.isServicePrincipal || u.principal === "service" || !isStaffRole(u.role)) { next(); return; }
      const d = db ?? (pool as unknown as Q);
      const scope = await scopeForRequest(req, d);
      if (scope.mode !== "all" && !(await canSeeRecord(d, scope, kind, id))) {
        res.status(404).json({ error: "not_found", message: "Record not found" });
        return;
      }
      next();
    })().catch(next);
  };
}
