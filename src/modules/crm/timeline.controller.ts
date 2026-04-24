import { type Request, type Response } from "express";
import { respondOk } from "../../utils/respondOk.js";
import { listCrmTimeline } from "./timeline.repo.js";

export async function handleListCrmTimeline(
  req: Request,
  res: Response
): Promise<void> {
  const page = Number(req.query.page) || 1;
  const pageSize = Number(req.query.pageSize) || 25;
  const entityType =
    typeof req.query.entityType === "string" ? req.query.entityType : null;
  const entityId =
    typeof req.query.entityId === "string" ? req.query.entityId : null;
  const ruleId = typeof req.query.ruleId === "string" ? req.query.ruleId : null;

  const limit = Math.min(200, Math.max(1, pageSize));
  const offset = Math.max(0, (page - 1) * limit);

  const entries = await listCrmTimeline({
    entityType,
    entityId,
    ruleId,
    limit,
    offset,
  });

  respondOk(
    res,
    entries,
    {
      page,
      pageSize: limit,
      total: entries.length,
    }
  );
}
