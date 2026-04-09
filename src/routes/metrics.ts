import { getMetrics } from "../system/metrics.js";
import { ok } from "../lib/respond.js";

export function metricsRoute(req: any, res: any) {
  return ok(res, getMetrics());
}
