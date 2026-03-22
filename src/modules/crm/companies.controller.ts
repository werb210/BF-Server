import { type Request, type Response } from "express";
import { logError } from "../../observability/logger";
import { respondOk } from "../../utils/respondOk";
import { getCompanies, getCompanyById } from "./companies.service";
import { toStringSafe } from "../../utils/toStringSafe";

function logCrmError(event: string, error: unknown): void {
  logError(event, {
    error,
    message: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined,
  });
}

export async function handleListCompanies(
  _req: Request,
  res: Response
): Promise<void> {
  try {
    const companies = await getCompanies();
    respondOk(res, companies);
  } catch (error) {
    logCrmError("crm_companies_list_failed", error);
    respondOk(res, []);
  }
}

export async function handleGetCompanyById(
  req: Request,
  res: Response
): Promise<void> {
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
    const company = await getCompanyById(companyId);
    if (!company) {
      res.status(404).json({
        code: "not_found",
        message: "Company not found.",
        requestId: res.locals.requestId ?? "unknown",
      });
      return;
    }
    respondOk(res, company);
  } catch (error) {
    logCrmError("crm_companies_fetch_failed", error);
    respondOk(res, []);
  }
}
