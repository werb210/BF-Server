// BF_SERVER_BLOCK_v209_LENDER_CACHE_CLEAR_AND_OCR_VISIBLE_LOGGING_v1
// OCR worker: replaced silent .catch handlers with console.error so failures
// appear in Azure App Service log stream (was silently dropping errors).
import { randomUUID } from "node:crypto";
import { config } from "../../config/index.js";
import { isKillSwitchEnabled } from "../ops/ops.service.js";
import { clearExpiredOcrLocks, lockOcrJobs } from "./ocr.repo.js";
import { processOcrJob } from "./ocr.service.js";

export function startOcrWorker(): { stop: () => void } {
  if (!config.features.ocrEnabled) {
    return { stop: () => undefined };
  }

  const workerId = randomUUID();
  const pollInterval = config.ocr.pollIntervalMs;
  const concurrency = config.ocr.workerConcurrency;

  let stopped = false;
  let running = false;

  const tick = async () => {
    if (stopped || running) {
      return;
    }
    running = true;
    try {
      // BF_SERVER_v798_OCR_LOG_LABELS - the kill-switch read is inside the try, so a database
      // timeout here logs as a skipped tick, not as a failed document.
      if (await isKillSwitchEnabled("ocr")) {
        return;
      }
      const jobs = await lockOcrJobs({ limit: concurrency, lockedBy: workerId });
      await Promise.all(
        jobs.map((job) =>
          processOcrJob(job).catch((err) => { console.error("[ocr.worker] processOcrJob FAILED:", (err && err.message) || err); })
        )
      );
    } catch (err) {
      // BF_SERVER_BLOCK_v210_LENDER_CATEGORY_ALIAS_AND_OCR_AUDIT_v1
      // Was silently swallowing. Likely culprit when OCR worker appears dead:
      // lockOcrJobs() throwing due to schema/query issue.
      console.error("[ocr.worker] tick skipped (no job lost; locked jobs are retried):", (err && (err as any).message) || err);
    } finally {
      running = false;
    }
  };

  const timer = setInterval(() => {
    tick().catch((err) => { console.error("[ocr.worker] tick skipped (no job lost):", (err && err.message) || err); });
  }, pollInterval);

  clearExpiredOcrLocks().catch((err) => { console.error("[ocr.worker] clearing expired OCR locks failed:", (err && err.message) || err); });

  tick().catch((err) => { console.error("[ocr.worker] tick skipped (no job lost):", (err && err.message) || err); });

  const stop = () => {
    stopped = true;
    clearInterval(timer);
    process.removeListener("SIGTERM", stop);
  };

  process.on("SIGTERM", stop);

  return { stop };
}
