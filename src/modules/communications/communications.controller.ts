import { type Request, type Response } from "express";
import { logError } from "../../observability/logger";
import { ok } from "../../lib/response";
import { fetchCommunications, fetchMessageFeed } from "./communications.service";

function logCommunicationsError(event: string, error: unknown): void {
  logError(event, {
    error,
    message: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined,
  });
}

export async function handleListCommunications(
  req: Request,
  _res: Response
): Promise<ReturnType<typeof ok>> {
  try {
    const contactId =
      typeof req.query.contactId === "string" ? req.query.contactId : null;
    const communications = await fetchCommunications({ contactId });
    return ok(communications, req.rid);
  } catch (error) {
    logCommunicationsError("communications_list_failed", error);
    return ok([], req.rid);
  }
}

export async function handleListMessages(
  req: Request,
  _res: Response
): Promise<ReturnType<typeof ok>> {
  try {
    const page = Number(req.query.page) || 1;
    const pageSize = Number(req.query.pageSize) || 25;
    const contactId =
      typeof req.query.contactId === "string" ? req.query.contactId : null;

    const messageFeed = await fetchMessageFeed({ contactId, page, pageSize });
    return ok({ messages: messageFeed.messages, total: messageFeed.total, page, pageSize }, req.rid);
  } catch (error) {
    logCommunicationsError("communications_messages_list_failed", error);
    return ok({ messages: [], total: 0, page: 1, pageSize: 25 }, req.rid);
  }
}
