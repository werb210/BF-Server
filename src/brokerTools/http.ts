// BF_SERVER_v867_BROKER_TOOLS - what every deal desk route shares: who may call it, the application guard (silo and record
// visibility, 404 otherwise) and the upload limits.
import type { NextFunction, Request, Response } from "express";
import multer from "multer";
import { auth, requireAuthorization } from "../middleware/auth.js";
import { ROLES } from "../auth/roles.js";
import { getSilo } from "../middleware/silo.js";
import { db, loadApplication } from "./common.js";
import { canSeeApplication } from "./platform.js";

export const staff = [auth, requireAuthorization({ roles: [ROLES.ADMIN, ROLES.STAFF] })];
export const admin = [auth, requireAuthorization({ roles: [ROLES.ADMIN] })];
export const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024, files: 1 } });

async function appGuardImpl(req: Request, res: Response, next: NextFunction) {
  const id = String(req.params.id ?? "").trim();
  const app = await loadApplication(db(), id);
  const silo = getSilo(res);
  if (!app || (app.silo && silo && app.silo !== silo) || !(await canSeeApplication(req, id))) {
    return void res.status(404).json({ ok: false, error: "not_found", message: "Application not found." });
  }
  res.locals.app = app;
  next();
}

/** Loads the application into res.locals.app; 404 when it is missing, in another silo, or not visible to the caller. */
export function appGuard(req: Request, res: Response, next: NextFunction): void {
  appGuardImpl(req, res, next).catch(next);
}

export function bad(res: Response, message: string, status = 400, error = "validation_error"): void {
  res.status(status).json({ ok: false, error, message });
}
