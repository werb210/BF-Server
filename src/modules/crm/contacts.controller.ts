import { type Request, type Response } from "express";
import { logError } from "../../observability/logger";
import { ok } from "../../lib/response";
import { fetchContacts } from "./contacts.service";

function logCrmError(event: string, error: unknown): void {
  logError(event, {
    error,
    message: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined,
  });
}

export async function handleListContacts(
  req: Request,
  _res: Response
): Promise<ReturnType<typeof ok>> {
  try {
    const companyId =
      typeof req.query.companyId === "string" ? req.query.companyId : null;
    const contacts = await fetchContacts({ companyId });
    return ok(contacts, req.rid);
  } catch (error) {
    logCrmError("crm_contacts_list_failed", error);
    return ok([], req.rid);
  }
}
