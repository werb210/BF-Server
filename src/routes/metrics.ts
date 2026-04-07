import { getMetrics } from "../system/metrics";
import { ok } from "../lib/response";

export function metricsRoute(req: any, res: any) {
  return ok(getMetrics(), req.rid);
}
