import { getMetrics } from "@/system/metrics";
import { ok } from "@/lib/respond";

export function metricsRoute(req: any, res: any) {
  return ok(res, getMetrics());
}
