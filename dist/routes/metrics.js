import { getMetrics } from "../system/metrics.js";
import { ok } from "../lib/respond.js";
export function metricsRoute(req, res) {
    return ok(res, getMetrics());
}
