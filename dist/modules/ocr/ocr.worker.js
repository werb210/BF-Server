"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.startOcrWorker = startOcrWorker;
const crypto_1 = require("crypto");
const config_1 = require("../../config");
const ops_service_1 = require("../ops/ops.service");
const ocr_repo_1 = require("./ocr.repo");
const ocr_service_1 = require("./ocr.service");
function startOcrWorker() {
    if (!config_1.config.features.ocrEnabled) {
        return { stop: () => undefined };
    }
    const workerId = (0, crypto_1.randomUUID)();
    const pollInterval = config_1.config.ocr.pollIntervalMs;
    const concurrency = config_1.config.ocr.workerConcurrency;
    let stopped = false;
    let running = false;
    const tick = async () => {
        if (stopped || running) {
            return;
        }
        if (await (0, ops_service_1.isKillSwitchEnabled)("ocr")) {
            return;
        }
        running = true;
        try {
            const jobs = await (0, ocr_repo_1.lockOcrJobs)({ limit: concurrency, lockedBy: workerId });
            await Promise.all(jobs.map((job) => (0, ocr_service_1.processOcrJob)(job).catch(() => undefined)));
        }
        catch {
            // swallow
        }
        finally {
            running = false;
        }
    };
    const timer = setInterval(() => {
        tick().catch(() => undefined);
    }, pollInterval);
    (0, ocr_repo_1.clearExpiredOcrLocks)().catch(() => undefined);
    tick().catch(() => undefined);
    const stop = () => {
        stopped = true;
        clearInterval(timer);
        process.removeListener("SIGTERM", stop);
    };
    process.on("SIGTERM", stop);
    return { stop };
}
