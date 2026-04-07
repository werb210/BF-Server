import { type Request, type Response } from "express";
import { ok } from "../../lib/response";
import { listCrmTimeline } from "./timeline.repo";

export async function handleListCrmTimeline(
  req: Request,
  _res: Response
): Promise<ReturnType<typeof ok>> {
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

  return ok(
    {
      entries,
      total: entries.length,
      page,
      pageSize: limit,
    },
    req.rid,
  );
}
