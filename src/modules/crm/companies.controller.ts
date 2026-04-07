import { type Request, type Response } from "express";
import { logError } from "../../observability/logger";
import { ok } from "../../lib/response";
import { fetchCompanies, fetchCompanyById } from "./companies.service";
import { toStringSafe } from "../../utils/toStringSafe";

function logCrmError(event: string, error: unknown): void {
  logError(event, {
    error,
    message: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined,
  });
}

export async function handleListCompanies(
  req: Request,
  _res: Response
): Promise<ReturnType<typeof ok>> {
  try {
    const companies = await fetchCompanies();
    return ok(companies, req.rid);
  } catch (error) {
    logCrmError("crm_companies_list_failed", error);
    return ok([], req.rid);
  }
}

export async function handleGetCompanyById(
  req: Request,
  res: Response
): Promise<void | ReturnType<typeof ok>> {
  try {
    const companyId = toStringSafe(req.params.id);
    if (!companyId) {
      res.status(400).json({
        code: "validation_error",
        message: "Company id is required.",
        requestId: res.locals.requestId ?? "unknown",
      });
      return;
    }
    const company = await fetchCompanyById(companyId);
    if (!company) {
      res.status(404).json({
        code: "not_found",
        message: "Company not found.",
        requestId: res.locals.requestId ?? "unknown",
      });
      return;
    }
    return ok(company, req.rid);
  } catch (error) {
    logCrmError("crm_companies_fetch_failed", error);
    return ok([], req.rid);
  }
}
