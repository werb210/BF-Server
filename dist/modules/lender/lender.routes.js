"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const zod_1 = require("zod");
const auth_1 = require("../../middleware/auth");
const idempotency_1 = require("../../middleware/idempotency");
const packageBuilder_1 = require("../../services/lenders/packageBuilder");
const lenderProducts_service_1 = require("../../services/lenderProducts/lenderProducts.service");
const lenderQueue_1 = require("../../queue/lenderQueue");
const logger_1 = require("../../server/utils/logger");
const sendLenderPackageSchema = zod_1.z.object({
    application: zod_1.z.object({}).passthrough(),
    documents: zod_1.z.array(zod_1.z.unknown()),
    creditSummary: zod_1.z.object({}).passthrough(),
});
const router = (0, express_1.Router)();
router.post("/send", auth_1.requireAuth, idempotency_1.idempotencyMiddleware, async (req, res, next) => {
    if (!req.body ||
        typeof req.body !== "object" ||
        !("application" in req.body) ||
        !req.body.application ||
        typeof req.body.application !== "object" ||
        !("id" in req.body.application) ||
        !req.body.application.id) {
        return res.status(400).json({
            error: {
                message: "invalid_lender_package_body",
                code: "invalid_input",
            },
        });
    }
    try {
        const parseResult = sendLenderPackageSchema.safeParse(req.body);
        if (!parseResult.success) {
            return res.status(400).json({
                error: {
                    message: "invalid_lender_package_body",
                    code: "invalid_input",
                },
            });
        }
        const body = parseResult.data;
        const packageData = (0, packageBuilder_1.buildLenderPackage)(body);
        const queue = (0, lenderQueue_1.getLenderQueue)();
        if (queue) {
            try {
                const jobId = await (0, lenderQueue_1.enqueueLenderPackage)(body);
                res.status(202).json({ status: "queued", jobId, packagePreview: packageData });
                return;
            }
            catch (queueErr) {
                logger_1.logger.warn("lender_package_queue_unavailable", {
                    err: queueErr instanceof Error ? queueErr.message : String(queueErr),
                });
            }
        }
        res["json"]({ status: "sent", package: packageData, mode: "sync_fallback" });
    }
    catch (err) {
        next(err);
    }
});
router.get("/products", auth_1.requireAuth, async (_req, res, next) => {
    try {
        const products = await lenderProducts_service_1.lenderProductsService.list();
        res["json"](products);
    }
    catch (err) {
        next(err);
    }
});
exports.default = router;
